import type { Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { GMAIL_SEND_SCOPE } from '../integrations/google';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { approveAndSend, undoQueued } from './send';
import { refreshSyncStatus, writeFromServer } from './serverSync';

/**
 * Plan 29 §B2.1: for an account, the server is the sender. An approved email goes to /drafts/approve with the words as
 * the student left them and the undo window, comes back as the server's draft, and an undo stops it there. Without a
 * server Gmail that may send, the browser's own path is unchanged.
 */

const DRAFT_ID = '7d1f0c52-5b8e-4a55-9a43-2f1c3b7e9a10';
let api: FakeOrbitApi;
let user: User;

beforeEach(async () => {
  await wipeDatabase();
  const signedIn = await signInToFakeApi();
  api = signedIn.api;
  user = signedIn.user as unknown as User;
  const at = '2026-10-06T12:00:00.000Z';
  await db.people.put({
    id: 'p_ivy',
    userId: user.id,
    displayName: 'Ivy Chen',
    firstName: 'Ivy',
    lastName: 'Chen',
    nameNormalized: 'ivy chen',
    emails: ['ivy@example.com'],
    primaryEmail: 'ivy@example.com',
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
    personId: 'p_ivy',
    chatId: null,
    goalId: null,
    channel: 'gmail' as const,
    kind: 'first_touch' as const,
    subject: 'Your talk on payments retries',
    body: 'Hi Ivy,\n\nYour talk on payments retries was the clearest thing I read this term. Would you have 15 minutes next week for two questions about how your team picks what to automate?\n\nBest,\nMaya',
    status: 'draft' as const,
    sendAt: null,
    sentAt: null,
    validator: { ok: true, issues: [], words: 40, grade: 7 },
    generatedBy: 'template' as const,
    hooks: [],
    needsInput: [],
    createdAt: at,
    updatedAt: at,
  };
  api.state.drafts.set(DRAFT_ID, { ...draft });
  await writeFromServer('drafts', [{ ...draft, toEmail: 'ivy@example.com' }], user.id);
});
afterEach(async () => {
  await leaveFakeApi();
});

describe('an account approves email on the server (plan 29 §B2.1)', () => {
  it('an autopilot schedule goes to the server with its planned time, not the undo window', async () => {
    api.state.status.google.scopes = [GMAIL_SEND_SCOPE];
    await refreshSyncStatus();
    const local = (await db.outbound.get(DRAFT_ID))!;
    const at = new Date('2026-10-07T12:40:00.000Z');
    const r = await approveAndSend(
      user,
      DRAFT_ID,
      local.bodyDraft,
      local.subject,
      new Date('2026-10-06T18:00:00Z'),
      {
        scheduleAt: at,
      },
    );
    expect(r).toMatchObject({ ok: true, status: 'scheduled', sendAt: at.toISOString() });
    expect(api.state.drafts.get(DRAFT_ID)?.sendAt).toBe(at.toISOString());
  });

  it('a server draft with no address here says what to connect, never that the person has no email', async () => {
    const local = (await db.outbound.get(DRAFT_ID))!;
    await db.outbound.update(DRAFT_ID, { toEmail: undefined });
    const r = await approveAndSend(user, DRAFT_ID, local.bodyDraft, local.subject);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/connect Gmail with permission to send/);
  });

  it('goes to /drafts/approve with the words and the undo window; undo stops it there', async () => {
    api.state.status.google.scopes = [GMAIL_SEND_SCOPE];
    await refreshSyncStatus();
    const local = (await db.outbound.get(DRAFT_ID))!;
    const body = `${local.bodyDraft}\n`;
    const r = await approveAndSend(user, DRAFT_ID, body, local.subject);
    expect(r).toMatchObject({ ok: true, status: 'scheduled' });
    expect(api.routes()).toContain('/drafts/approve');
    // the browser holds the server's answer and sends nothing itself
    const after = (await db.outbound.get(DRAFT_ID))!;
    expect(after.status).toBe('approved');
    expect(api.state.drafts.get(DRAFT_ID)!.status).toBe('approved');
    // ten seconds, as the browser's own undo window
    const wait = Date.parse(after.sendAt!) - Date.now();
    expect(wait).toBeGreaterThan(5_000);
    expect(wait).toBeLessThanOrEqual(10_500);
    expect(await undoQueued(user, DRAFT_ID)).toBe(true);
    expect(api.state.drafts.get(DRAFT_ID)!.status).toBe('cancelled');
    expect((await db.outbound.get(DRAFT_ID))!.status).toBe('cancelled');
  });

  it('without a server Gmail that may send, the browser path is unchanged', async () => {
    api.state.status.google.scopes = [];
    await refreshSyncStatus();
    const local = (await db.outbound.get(DRAFT_ID))!;
    const r = await approveAndSend(user, DRAFT_ID, local.bodyDraft, local.subject);
    expect(r.ok).toBe(true);
    expect(r.ok && r.status).not.toBe('scheduled');
    expect(api.routes()).not.toContain('/drafts/approve');
  });
});
