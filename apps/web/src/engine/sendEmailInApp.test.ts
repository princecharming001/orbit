import type { OutboundMessage, Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { GMAIL_SEND_SCOPE } from '../integrations/google';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { draftTypedMessage } from './brief';
import { approveAndSend, emailWriteError, undoQueued } from './send';
import { pullNow, refreshSyncStatus, serverIdOf } from './serverSync';

/**
 * An email the student wrote themselves (on a person's page, in Drafts, in the conversation box) is sent by Orbit
 * from their own Gmail, exactly like one the server composed. The draft was made in this browser, so the server
 * learns of it with the tap that sends it. It used to answer "not found", and the mail app opened instead. The undo
 * window stays, and when Orbit cannot send, the answer says why instead of opening the mail app.
 */

const PERSON_ID = 'p_5b0e7c1a-9d3f-4c26-8e41-1f6a2d7c9b30';
const TEXT = 'Hi Ivy, thanks again for the call on Tuesday. I sent the notes over this morning.';
let api: FakeOrbitApi;
let user: User;
let draft: OutboundMessage;

beforeEach(async () => {
  await wipeDatabase();
  const signedIn = await signInToFakeApi();
  api = signedIn.api;
  user = signedIn.user as unknown as User;
  const at = '2026-11-20T12:00:00.000Z';
  await db.people.put({
    id: PERSON_ID,
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
  // the conversation box on Ivy's page: the student's own words, a draft made in this browser
  draft = (await draftTypedMessage(user, PERSON_ID, 'gmail', TEXT))!;
  api.state.status.google.scopes = [GMAIL_SEND_SCOPE];
  await refreshSyncStatus();
});
afterEach(async () => {
  await leaveFakeApi();
});

const approvals = () => api.calls.filter((c) => c.route === '/drafts/approve');

describe('an email the student wrote is sent in the app', () => {
  it('the draft is this browser own: the server has never heard of it', () => {
    expect(draft.id).toMatch(/^out_/);
    expect(draft.subject).toBe('Following up');
    expect(serverIdOf(draft.id)).toBeDefined();
    expect(api.state.drafts.has(serverIdOf(draft.id)!)).toBe(false);
  });

  it('Send goes to the server with who it is for, and the mail app is never opened', async () => {
    const r = await approveAndSend(user, draft.id, TEXT, draft.subject);
    expect(r).toMatchObject({ ok: true, status: 'scheduled' });
    // one approval, carrying the words, the subject, and who it is for (the server keeps it under the draft's own id)
    expect(approvals()).toHaveLength(1);
    expect(approvals()[0]!.body).toMatchObject({
      draftId: serverIdOf(draft.id),
      body: TEXT,
      subject: 'Following up',
      write: { personId: serverIdOf(PERSON_ID), kind: 'reply', channel: 'gmail', to: 'ivy@example.com' },
    });
    // an email keeps its undo window: the tap is not a LinkedIn-style confirmation
    expect((approvals()[0]!.body as { confirm?: boolean }).confirm).not.toBe(true);
    expect(api.state.drafts.get(serverIdOf(draft.id)!)).toMatchObject({
      status: 'approved',
      channel: 'gmail',
      kind: 'reply',
      body: TEXT,
      subject: 'Following up',
    });
    // this browser's own row is the one that is going: approved, never handed off, and still the only one
    const mine = (await db.outbound.get(draft.id))!;
    expect(mine).toMatchObject({ status: 'approved', personId: PERSON_ID, kind: 'reply' });
    expect(mine.handoffVia).toBeUndefined();
    expect(await db.outbound.count()).toBe(1);
    const wait = Date.parse(mine.sendAt!) - Date.now();
    expect(wait).toBeGreaterThan(5_000);
    expect(wait).toBeLessThanOrEqual(10_500);
  });

  it('Undo stops it on the server', async () => {
    await approveAndSend(user, draft.id, TEXT, draft.subject);
    expect(await undoQueued(user, draft.id)).toBe(true);
    expect(api.state.drafts.get(serverIdOf(draft.id)!)!.status).toBe('cancelled');
    // the student stopped it themselves: a draft again here, ready to change and send
    const mine = (await db.outbound.get(draft.id))!;
    expect(mine.status).toBe('draft');
    expect(mine.sendAt).toBeUndefined();
    expect(mine.error).toBeUndefined();
  });

  it('a send the server could not make says why on the same row, in words about email', async () => {
    await approveAndSend(user, draft.id, TEXT, draft.subject);
    api.state.pages.push({
      changes: {
        drafts: [{ ...api.state.drafts.get(serverIdOf(draft.id)!)!, status: 'failed', error: 'gmail_500' }],
      },
    });
    await pullNow(user.id);
    expect(await db.outbound.get(draft.id)).toMatchObject({
      status: 'failed',
      error: 'Gmail did not take it just now. Try again in a moment.',
    });
    expect(await db.outbound.count()).toBe(1);
  });

  it('the next sync brings the sent copy down onto the same row, not a second one', async () => {
    await approveAndSend(user, draft.id, TEXT, draft.subject);
    const sent = '2026-11-20T12:05:00.000Z';
    api.state.pages.push({
      changes: {
        drafts: [
          { ...api.state.drafts.get(serverIdOf(draft.id)!)!, status: 'sent', sentAt: sent, sendAt: sent },
        ],
      },
    });
    await pullNow(user.id);
    expect(await db.outbound.count()).toBe(1);
    expect(await db.outbound.get(draft.id)).toMatchObject({ status: 'sent', kind: 'reply', bodyDraft: TEXT });
  });

  it('an edit made before Send is what goes', async () => {
    const edited = `${TEXT} Talk soon.`;
    const r = await approveAndSend(user, draft.id, edited, 'Notes from Tuesday');
    expect(r).toMatchObject({ ok: true });
    expect(api.state.drafts.get(serverIdOf(draft.id)!)).toMatchObject({
      body: edited,
      subject: 'Notes from Tuesday',
    });
  });

  it('a second tap on Send does not make a second draft on the server', async () => {
    await approveAndSend(user, draft.id, TEXT, draft.subject);
    await undoQueued(user, draft.id);
    const r = await approveAndSend(user, draft.id, TEXT, draft.subject);
    expect(r).toMatchObject({ ok: true, status: 'scheduled' });
    expect(api.state.drafts.size).toBe(1);
    expect(await db.outbound.count()).toBe(1);
  });

  it('a server that cannot keep it says so; the mail app is not opened behind the student', async () => {
    // an older server: it does not read who the message is for, and has never heard of this draft
    api.state.ignoreWrite = true;
    const r = await approveAndSend(user, draft.id, TEXT, draft.subject);
    expect(r).toMatchObject({
      ok: false,
      error: 'Orbit could not send this itself just now. Try again in a moment.',
    });
    const mine = (await db.outbound.get(draft.id))!;
    expect(mine.status).toBe('draft');
    expect(mine.handoffVia).toBeUndefined();
  });

  it('the reasons the server gives read as plain sentences', () => {
    expect(emailWriteError('no_email', 'x')).toBe(
      'Orbit has no email address for them yet. Add one on their page, then send.',
    );
    expect(emailWriteError('needs_subject', 'x')).toBe('Add a subject line.');
    expect(emailWriteError('person_not_found', 'x')).toBe(
      'Orbit has not saved this person to your account yet. Try again in a moment.',
    );
    // anything else is the server's own sentence (a different address on file names both)
    expect(emailWriteError('recipient_differs', 'Orbit has a@x.com for them, not b@x.com.')).toBe(
      'Orbit has a@x.com for them, not b@x.com.',
    );
    for (const code of ['no_email', 'needs_subject', 'person_not_found', 'not_found'])
      expect(emailWriteError(code, '')).not.toMatch(/[—!]/);
  });

  it('without a Gmail that may send from the server, nothing is asked of it', async () => {
    api.state.status.google.scopes = [];
    await refreshSyncStatus();
    await approveAndSend(user, draft.id, TEXT, draft.subject).catch(() => undefined);
    expect(approvals()).toHaveLength(0);
  });
});
