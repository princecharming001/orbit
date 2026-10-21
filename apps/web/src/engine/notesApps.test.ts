import type { User } from '@orbit/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { setNotesProxyUrlForTests } from '../integrations/notesApps';
import { calStatus, connectCalcom, disconnectCalcom, eventTypeLabel, offeredEventTypes } from './calcom';
import { loadDemo } from './demo';
import {
  autoSyncFathom,
  connectFathom,
  disconnectFathom,
  fathomStatus,
  meetingNoteText,
  otherInvitees,
  syncFathom,
} from './fathom';

let user: User;

beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 90_000);

afterEach(() => {
  vi.restoreAllMocks();
  setConnectorsMockForTests(undefined);
  setNotesProxyUrlForTests(undefined);
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('Fathom', () => {
  it('the sample student: connecting files made-up meetings on the people in them, once', async () => {
    const r = await connectFathom(user, '');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.imported).toBeGreaterThan(0);
    const notes = await db.notes
      .where('userId')
      .equals(user.id)
      .filter((n) => n.source === 'fathom')
      .toArray();
    expect(notes.length).toBe(r.imported);
    expect(notes.every((n) => n.personIds.length > 0)).toBe(true);
    expect(notes[0]!.rawText).toMatch(/Action items:/);
    const again = await syncFathom(user);
    expect(again).toMatchObject({ ok: true, imported: 0 });
    const st = await fathomStatus(user);
    expect(st).toMatchObject({ connected: true, meetings: r.imported, demo: true });
    // a fresh sync is not redone on app open
    expect(await autoSyncFathom(user)).toBeUndefined();
    await disconnectFathom(user);
    expect((await fathomStatus(user)).connected).toBe(false);
    // the notes stay on people's pages
    expect(
      await db.notes
        .where('userId')
        .equals(user.id)
        .filter((n) => n.source === 'fathom')
        .count(),
    ).toBe(notes.length);
  });

  it('a real key: checks it, pages through meetings, matches by invite email and skips solo recordings', async () => {
    setConnectorsMockForTests(false);
    setNotesProxyUrlForTests('https://proxy.test/orbit-notes');
    const person = (await db.people.where('userId').equals(user.id).toArray()).find((p) => !!p.primaryEmail)!;
    const meeting = (id: string, invitees: { name: string; email: string }[]) => ({
      id,
      title: `Chat ${id}`,
      startAt: '2026-10-15T15:00:00Z',
      invitees,
      recordedBy: user.email,
      summary: '## Notes\n- Talked about the team',
      actionItems: [{ text: 'Send the deck', done: false }],
    });
    const calls: { createdAfter?: string; cursor?: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        apiKey: string;
        createdAfter?: string;
        cursor?: string;
      };
      expect(body.apiKey).toBe('fathom-key-123456');
      calls.push(body);
      if (calls.length === 1) return json({ ok: true, meetings: [], nextCursor: null }); // the key check
      if (!body.cursor)
        return json({
          ok: true,
          meetings: [meeting('m1', [{ name: person.displayName, email: person.primaryEmail! }])],
          nextCursor: 'p2',
        });
      return json({
        ok: true,
        meetings: [meeting('m2', [{ name: user.fullName, email: user.email }])],
        nextCursor: null,
      });
    });
    const r = await connectFathom(user, 'fathom-key-123456');
    expect(r).toMatchObject({ ok: true, imported: 1, skipped: 1 });
    expect(calls.map((c) => c.cursor ?? null)).toEqual([null, null, 'p2']);
    const note = await db.notes.where('[source+externalId]').equals(['fathom', 'fathom:m1']).first();
    expect(note?.personIds).toContain(person.id);
    // the key is kept on the row in this browser, never in the notes
    const row = await db.integrations
      .where('userId')
      .equals(user.id)
      .filter((i) => i.provider === 'fathom')
      .first();
    expect(row?.accessToken).toBe('fathom-key-123456');
    expect(note?.rawText).not.toContain('fathom-key');
  });

  it('a refused key says so and marks the row for a new key', async () => {
    setConnectorsMockForTests(false);
    setNotesProxyUrlForTests('https://proxy.test/orbit-notes');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ ok: false, reason: 'bad_key', message: 'Fathom did not accept that API key.' }),
    );
    expect(await connectFathom(user, 'wrong-key-123456')).toMatchObject({ ok: false, reason: 'bad_key' });
  });

  it('formats a note and leaves the student out of the attendees', () => {
    const m = {
      id: 'x',
      title: 'Coffee chat',
      invitees: [
        { name: 'Me', email: user.email },
        { name: 'Priya', email: 'priya@stripe.com' },
      ],
      summary: 'She leads onboarding.',
      actionItems: [{ text: 'Send resume', done: true, assignee: 'Me' }],
      url: 'https://fathom.video/share/x',
    };
    expect(otherInvitees(m, user)).toEqual([{ name: 'Priya', email: 'priya@stripe.com' }]);
    expect(meetingNoteText(m)).toBe(
      'Coffee chat\n\nShe leads onboarding.\n\nAction items:\n- [done] Send resume (Me)\n\nRecording: https://fathom.video/share/x',
    );
  });
});

describe('Cal.com', () => {
  it('the sample student: two event types, and the first becomes the scheduling link when none is set', async () => {
    await db.settings.update(user.id, { schedulingLink: undefined });
    const r = await connectCalcom(user, '');
    expect(r.ok && r.eventTypes.map((t) => t.title)).toEqual(['15 min chat', '30 min coffee chat']);
    expect((await db.settings.get(user.id))?.schedulingLink).toMatch(/^https:\/\/cal\.com\/.+\/15min$/);
    const st = await calStatus(user);
    expect(st.connected).toBe(true);
    expect(eventTypeLabel(st.eventTypes[1]!)).toMatch(/^30 min coffee chat · cal\.com\/.+\/30min$/);
    await disconnectCalcom(user);
    expect((await calStatus(user)).connected).toBe(false);
    // the chosen link stays as a plain link
    expect((await db.settings.get(user.id))?.schedulingLink).toMatch(/15min$/);
  });

  it('a real key: keeps the event types and leaves a link already chosen alone', async () => {
    setConnectorsMockForTests(false);
    setNotesProxyUrlForTests('https://proxy.test/orbit-notes');
    await db.settings.update(user.id, { schedulingLink: 'https://calendly.com/me/chat' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        ok: true,
        username: 'sam',
        eventTypes: [
          {
            id: 7,
            title: 'Intro',
            slug: 'intro',
            minutes: 20,
            hidden: false,
            url: 'https://cal.com/sam/intro',
          },
        ],
      }),
    );
    const r = await connectCalcom(user, 'cal_live_abcdef123');
    expect(r).toMatchObject({ ok: true, username: 'sam' });
    expect((await db.settings.get(user.id))?.schedulingLink).toBe('https://calendly.com/me/chat');
    expect((await calStatus(user)).username).toBe('sam');
  });

  it('offers visible event types first, shortest first', () => {
    const t = (id: number, minutes: number, hidden = false) => ({
      id,
      title: `${minutes}`,
      slug: `${minutes}`,
      minutes,
      hidden,
      url: `https://cal.com/a/${minutes}`,
    });
    expect(offeredEventTypes([t(1, 60), t(2, 15, true), t(3, 30)]).map((x) => x.id)).toEqual([3, 1, 2]);
  });
});
