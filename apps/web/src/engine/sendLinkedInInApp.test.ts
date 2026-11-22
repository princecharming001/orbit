import type { OutboundMessage, Person, User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { leaveFakeApi, signInToFakeApi } from '../test/account';
import type { FakeOrbitApi } from '../test/fakeOrbitApi';
import { draftTypedMessage } from './brief';
import { linkedInSendActive, linkedInSendWay } from './linkedinLive';
import { approveAndSend, canSendFromOrbit, sendHandedOffFromOrbit } from './send';
import { pullNow, refreshSyncStatus, serverIdOf, syncStatusNow } from './serverSync';

/**
 * "Always send in app": a LinkedIn message the student wrote themselves (on a person's page, in Drafts, in the
 * conversation box) is sent by Orbit from their own LinkedIn on the tap of Send, exactly like one the server
 * composed. The draft was made in this browser, so the server learns of it with that tap. LinkedIn is opened for a
 * paste only when the student picks that way themselves, and when Orbit cannot send, the answer says why.
 */

const PERSON_ID = 'p_3f0a6c1e-2b7d-4e58-9c14-7a5d2e9b1c60';
const TEXT = 'hey kelly, hope things are good.';
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
    displayName: 'Kelly Gieryn',
    firstName: 'Kelly',
    lastName: 'Gieryn',
    nameNormalized: 'kelly gieryn',
    emails: [],
    linkedinSlug: 'kellygieryn',
    linkedinUrl: 'https://www.linkedin.com/in/kellygieryn',
    linkedinConnectedOn: '2025-03-02',
    tieScore: 40,
    relationshipType: 'unknown',
    strength: 0.4,
    interactionCount: 0,
    sources: ['manual'],
    isHuman: true,
    tags: [],
    createdAt: at,
    updatedAt: at,
  } as Person);
  // the conversation box on Kelly's page: the student's own words, a draft made in this browser
  draft = (await draftTypedMessage(user, PERSON_ID, 'linkedin', TEXT))!;
});
afterEach(async () => {
  await leaveFakeApi();
});

const approvals = () => api.calls.filter((c) => c.route === '/drafts/approve');
const statusAsks = () => api.calls.filter((c) => c.route === '/sync/status').length;

describe('a LinkedIn message the student wrote is sent in the app', () => {
  it('the draft is this browser own: the server has never heard of it', () => {
    expect(draft.id).toMatch(/^out_/);
    expect(serverIdOf(draft.id)).toBeDefined();
    expect(api.state.drafts.has(serverIdOf(draft.id)!)).toBe(false);
  });

  it('Send goes out from Orbit on that one tap, and LinkedIn is never opened', async () => {
    api.state.linkedin.status = 'active';
    await refreshSyncStatus();
    const person = (await db.people.get(PERSON_ID))!;
    expect(await linkedInSendActive(user, person, draft.id)).toBe(true);

    const r = await approveAndSend(user, draft.id, TEXT, undefined);
    expect(r).toMatchObject({ ok: true, status: 'sent' });
    // one approval, carrying the tap, the words, and who it is for (the server keeps it under the draft's own id)
    expect(approvals()).toHaveLength(1);
    expect(approvals()[0]!.body).toMatchObject({
      draftId: serverIdOf(draft.id),
      body: TEXT,
      confirm: true,
      write: { personId: serverIdOf(PERSON_ID), kind: 'reply', channel: 'linkedin' },
    });
    expect(api.state.drafts.get(serverIdOf(draft.id)!)).toMatchObject({ status: 'sent', body: TEXT });
    // this browser's own row is the one that went: sent, never handed off, and still the only one
    const mine = (await db.outbound.get(draft.id))!;
    expect(mine).toMatchObject({ status: 'sent', bodyFinal: TEXT, kind: 'reply', personId: PERSON_ID });
    expect(mine.handoffVia).toBeUndefined();
    expect(mine.sentAt).toBeTruthy();
    expect(await db.outbound.count()).toBe(1);
    // it is on Kelly's timeline like any message sent from Orbit
    const touches = await db.touchpoints.where('personId').equals(PERSON_ID).toArray();
    expect(touches.map((t) => t.kind)).toEqual(['linkedin_out']);
  });

  it('the next sync brings the server copy down onto the same row, not a second one', async () => {
    api.state.linkedin.status = 'active';
    await refreshSyncStatus();
    await approveAndSend(user, draft.id, TEXT, undefined);
    api.state.pages.push({ changes: { drafts: [{ ...api.state.drafts.get(serverIdOf(draft.id)!)! }] } });
    await pullNow(user.id);
    expect(await db.outbound.count()).toBe(1);
    expect(await db.outbound.get(draft.id)).toMatchObject({ status: 'sent', kind: 'reply', bodyDraft: TEXT });
  });

  it('an answer this browser never heard (the tab closed mid-send): the next sync says it went, so it is not sent twice', async () => {
    api.state.linkedin.status = 'active';
    await refreshSyncStatus();
    // the server sent it, but the answer was lost on the way back: here it is still a draft
    await approveAndSend(user, draft.id, TEXT, undefined);
    await db.outbound.update(draft.id, { status: 'draft', sentAt: undefined });
    api.state.pages.push({ changes: { drafts: [{ ...api.state.drafts.get(serverIdOf(draft.id)!)! }] } });
    await pullNow(user.id);
    const row = (await db.outbound.get(draft.id))!;
    expect(row.status).toBe('sent');
    expect(row.sentAt).toBeTruthy();
    // and a second tap finds nothing left to send
    const again = await approveAndSend(user, draft.id, TEXT, undefined);
    expect(again).toMatchObject({ ok: false, error: 'This message was already sent.' });
    expect(approvals()).toHaveLength(1);
  });

  it('a first message to someone who is not a connection goes from Orbit too, as a request with the note', async () => {
    api.state.linkedin.status = 'active';
    await refreshSyncStatus();
    await db.people.update(PERSON_ID, { linkedinConnectedOn: undefined, linkedinMemberId: undefined });
    await db.outbound.update(draft.id, { kind: 'outreach' });
    const r = await approveAndSend(user, draft.id, TEXT, undefined);
    expect(r).toMatchObject({ ok: true, status: 'sent' });
    expect(approvals()[0]!.body).toMatchObject({ confirm: true, write: { kind: 'outreach' } });
    expect((await db.outbound.get(draft.id))?.handoffVia).toBeUndefined();
  });

  it('a link made a minute ago counts: a kept "not connected" is checked once more before giving up', async () => {
    // what this browser last heard: LinkedIn not connected
    await refreshSyncStatus();
    expect(syncStatusNow()?.integrations.some((i) => i.provider === 'linkedin')).toBe(false);
    // the student links LinkedIn (in Settings, another tab); the kept answer is now stale
    api.state.linkedin.status = 'active';
    const before = statusAsks();
    const r = await approveAndSend(user, draft.id, TEXT, undefined);
    expect(r).toMatchObject({ ok: true, status: 'sent' });
    expect(statusAsks()).toBe(before + 1);
    expect((await db.outbound.get(draft.id))?.status).toBe('sent');
  });

  it('the screen learns of the new link too, asking the server once and not on every look', async () => {
    await refreshSyncStatus();
    api.state.linkedin.status = 'active';
    const before = statusAsks();
    const person = (await db.people.get(PERSON_ID))!;
    expect(await linkedInSendActive(user, person, draft.id)).toBe(true);
    expect(await linkedInSendActive(user, person, draft.id)).toBe(true);
    expect(statusAsks()).toBe(before + 1);
    // really not connected: asked once, then the kept answer serves the next looks
    api.state.linkedin.status = 'not_connected';
    await refreshSyncStatus();
    const again = statusAsks();
    for (let i = 0; i < 4; i++) expect(await linkedInSendActive(user, person, draft.id)).toBe(false);
    expect(statusAsks()).toBeLessThanOrEqual(again + 1);
  });
});

describe('when Orbit cannot send a LinkedIn message itself', () => {
  it('not connected: Send says why and where to fix it, and LinkedIn is not opened behind their back', async () => {
    await refreshSyncStatus();
    const person = (await db.people.get(PERSON_ID))!;
    const way = await linkedInSendWay(user, person, draft.id);
    expect(way).toMatchObject({
      inApp: false,
      reason: 'not_connected',
      text: 'LinkedIn is not connected. Reconnect it to send from Orbit.',
      fix: { label: 'Reconnect LinkedIn', to: '/settings/integrations' },
    });
    const r = await approveAndSend(user, draft.id, TEXT, undefined);
    expect(r).toMatchObject({
      ok: false,
      error: 'LinkedIn is not connected. Reconnect it to send from Orbit.',
      linkedin: 'not_connected',
    });
    expect(approvals()).toHaveLength(0);
    // still the student's draft, not something waiting for "I sent it"
    expect(await db.outbound.get(draft.id)).toMatchObject({ status: 'draft' });
    expect((await db.outbound.get(draft.id))?.handoffVia).toBeUndefined();
  });

  it('a link Orbit paused, or one LinkedIn signed out, says so in its own words', async () => {
    const person = (await db.people.get(PERSON_ID))!;
    api.state.linkedin.status = 'parked';
    await refreshSyncStatus();
    expect(await linkedInSendWay(user, person, draft.id)).toMatchObject({
      inApp: false,
      reason: 'paused',
      fix: { to: '/settings/integrations' },
    });
    api.state.linkedin.status = 'needs_reauth';
    await refreshSyncStatus();
    const out = await linkedInSendWay(user, person, draft.id);
    expect(out).toMatchObject({ inApp: false, reason: 'signed_out' });
    for (const w of [out]) expect(w.inApp === false && w.text).not.toMatch(/[—–!]/);
  });

  it('pasting it into LinkedIn is still there, as the way the student picks themselves', async () => {
    await refreshSyncStatus();
    const r = await approveAndSend(user, draft.id, TEXT, undefined, new Date(), { via: 'handoff' });
    expect(r).toMatchObject({ ok: true, status: 'handed_off', via: 'linkedin_compose' });
    expect(approvals()).toHaveLength(0);
    // and once LinkedIn is linked again, the waiting message can go from Orbit after all
    api.state.linkedin.status = 'active';
    await refreshSyncStatus();
    const waiting = (await db.outbound.get(draft.id))!;
    expect(await canSendFromOrbit(user, waiting)).toBe(true);
    expect(await sendHandedOffFromOrbit(user, draft.id)).toMatchObject({ ok: true, status: 'sent' });
    expect((await db.outbound.get(draft.id))?.status).toBe('sent');
  });

  it('a send LinkedIn refused shows the reason and keeps the words; nothing is handed off', async () => {
    api.state.linkedin.status = 'active';
    api.state.linkedin.sendError = 'unipile_422';
    await refreshSyncStatus();
    const r = await approveAndSend(user, draft.id, TEXT, undefined);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/LinkedIn would not take this message/);
    const kept = (await db.outbound.get(draft.id))!;
    expect(kept.status).toBe('failed');
    expect(kept.bodyFinal ?? kept.bodyDraft).toBe(TEXT);
    expect(kept.error).toMatch(/LinkedIn would not take this message/);
    expect(kept.handoffVia).toBeUndefined();
    expect(await db.outbound.count()).toBe(1);
    // the same draft goes once LinkedIn takes it
    api.state.linkedin.sendError = undefined;
    expect(await approveAndSend(user, draft.id, TEXT, undefined)).toMatchObject({ ok: true, status: 'sent' });
    expect(await db.outbound.get(draft.id)).toMatchObject({ status: 'sent' });
    expect((await db.outbound.get(draft.id))?.error).toBeUndefined();
  });

  it('the link dropped since this browser last looked: the server says so, and the answer offers the fix', async () => {
    api.state.linkedin.status = 'active';
    await refreshSyncStatus();
    // dropped on the server, while this browser still holds "active"
    api.state.linkedin.sendError = 'linkedin_not_connected';
    const r = await approveAndSend(user, draft.id, TEXT, undefined);
    expect(r).toMatchObject({ ok: false, linkedin: 'not_connected' });
    expect(!r.ok && r.error).toBe('LinkedIn is not connected. Reconnect it to send from Orbit.');
    expect((await db.outbound.get(draft.id))?.handoffVia).toBeUndefined();
  });

  it('a server from before this change (it has no such draft) is an error with the words kept, never a hand-off', async () => {
    api.state.linkedin.status = 'active';
    api.state.ignoreWrite = true;
    await refreshSyncStatus();
    const r = await approveAndSend(user, draft.id, TEXT, undefined);
    expect(r.ok).toBe(false);
    expect(await db.outbound.get(draft.id)).toMatchObject({ status: 'draft' });
    expect((await db.outbound.get(draft.id))?.handoffVia).toBeUndefined();
  });
});

describe('a LinkedIn message never goes without the tap', () => {
  it('a planned time is refused for LinkedIn: nothing is approved on the server, nothing is queued here', async () => {
    api.state.linkedin.status = 'active';
    await refreshSyncStatus();
    const r = await approveAndSend(user, draft.id, TEXT, undefined, new Date(), {
      scheduleAt: new Date(Date.now() + 3 * 3600_000),
    });
    expect(r.ok).toBe(false);
    expect(approvals()).toHaveLength(0);
    expect(await db.outbound.get(draft.id)).toMatchObject({ status: 'draft' });
  });

  it('writing, saving and syncing a draft sends nothing: only approveAndSend reaches /drafts/approve', async () => {
    api.state.linkedin.status = 'active';
    await refreshSyncStatus();
    const person = (await db.people.get(PERSON_ID))!;
    // everything the screens do before the tap
    await linkedInSendWay(user, person, draft.id);
    await linkedInSendActive(user, person, draft.id);
    await canSendFromOrbit(user, draft);
    await db.outbound.update(draft.id, { bodyFinal: `${TEXT} one more line.` });
    await pullNow(user.id);
    expect(approvals()).toHaveLength(0);
    expect(api.state.drafts.size).toBe(0);
    // and every approval that does go carries the tap
    await approveAndSend(user, draft.id, TEXT, undefined);
    expect(approvals().every((c) => (c.body as { confirm?: boolean }).confirm === true)).toBe(true);
  });
});
