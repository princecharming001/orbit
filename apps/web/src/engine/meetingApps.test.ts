import type { User } from '@orbit/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { setNotesProxyUrlForTests } from '../integrations/notesApps';
import { loadDemo } from './demo';
import { connectFathom, fathomStatus } from './fathom';
import {
  connectMeetingApp,
  mapFirefliesTranscript,
  mapWisprMeeting,
  meetingAppStatus,
  parseFirefliesActions,
  parseGranolaMeetings,
  syncMeetingApp,
} from './meetingApps';

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

const GRANOLA_LIST = `<meetings_data from="Jan 27, 2026" to="Feb 4, 2026" count="2">
<meeting id="0dba4400-50f1-4262-9ac7-89cd27b79371" title="Coffee &amp; careers" date="Feb 4, 2026 7:30 PM">
    <known_participants>
    John Doe (note creator) from Acme <john@acme.com>
    Jane Smith from Stripe <jane@stripe.com>
    </known_participants>
  </meeting>
</meetings_data>`;

describe('reading each app', () => {
  it('Granola: tagged meetings, their people (the note taker marked) and the summary with private notes', () => {
    const [m] = parseGranolaMeetings(GRANOLA_LIST);
    expect(m).toMatchObject({
      id: '0dba4400-50f1-4262-9ac7-89cd27b79371',
      title: 'Coffee & careers',
      url: 'https://notes.granola.ai/d/0dba4400-50f1-4262-9ac7-89cd27b79371',
      recordedBy: 'john@acme.com',
      invitees: [
        { name: 'John Doe', email: 'john@acme.com' },
        { name: 'Jane Smith', email: 'jane@stripe.com' },
      ],
    });
    expect(m!.startAt?.startsWith('2026-02-0')).toBe(true);
    const [full] = parseGranolaMeetings(
      GRANOLA_LIST.replace(
        '</known_participants>',
        '</known_participants>\n<summary>\n## Action Items\n- Send resume\n</summary>\n<private_notes>Ask about rotations</private_notes>',
      ),
    );
    expect(full!.summary).toBe('## Action Items\n- Send resume\n\nMy notes:\nAsk about rotations');
    expect(parseGranolaMeetings('no meetings here')).toEqual([]);
  });

  it('Fireflies: attendees from the invite and the guest list, summary, and action items under their owner', () => {
    const m = mapFirefliesTranscript({
      id: 'ff1',
      title: 'Chat with Jane',
      date: Date.parse('2026-10-15T15:00:00Z'),
      transcript_url: 'https://app.fireflies.ai/view/ff1',
      organizer_email: 'me@cornell.edu',
      participants: ['jane@stripe.com, guest@x.com'],
      meeting_attendees: [{ displayName: 'Jane Smith', email: 'jane@stripe.com' }],
      summary: {
        overview: 'Jane leads payments onboarding.',
        shorthand_bullet: '- Hiring in spring',
        action_items:
          '**Alex Rivera**\nSend Jane the deck (12:04)\n\n**Jane Smith**\nIntro to the recruiter (20:11)',
      },
    });
    expect(m).toMatchObject({
      startAt: '2026-10-15T15:00:00.000Z',
      recordedBy: 'me@cornell.edu',
      summary: 'Jane leads payments onboarding.\n\n- Hiring in spring',
      invitees: [{ name: 'Jane Smith', email: 'jane@stripe.com' }, { email: 'guest@x.com' }],
    });
    expect(m!.actionItems).toEqual([
      { text: 'Send Jane the deck', done: false, assignee: 'Alex Rivera' },
      { text: 'Intro to the recruiter', done: false, assignee: 'Jane Smith' },
    ]);
    expect(parseFirefliesActions('- Follow up Friday')).toEqual([{ text: 'Follow up Friday', done: false }]);
  });

  it('Wispr Flow: a meeting from whichever field names its server uses', () => {
    expect(
      mapWisprMeeting({
        meeting_id: 'w1',
        title: 'Sync',
        start_time: '2026-10-15T15:00:00Z',
        share_link: 'https://wisprflow.ai/m/w1',
        attendees: [{ name: 'Jane Smith', email: 'jane@stripe.com' }, 'Bo Lee'],
        summary: '## Next steps\n- Send resume',
      }),
    ).toMatchObject({
      id: 'w1',
      url: 'https://wisprflow.ai/m/w1',
      startAt: '2026-10-15T15:00:00.000Z',
      invitees: [{ name: 'Jane Smith', email: 'jane@stripe.com' }, { name: 'Bo Lee' }],
      summary: '## Next steps\n- Send resume',
    });
    expect(mapWisprMeeting({ title: 'no id' })).toBeUndefined();
  });
});

describe('picking one meeting app', () => {
  it('the sample student: turning Granola on turns Fathom off, and the same meetings are not filed twice', async () => {
    const f = await connectFathom(user, '');
    expect(f.ok).toBe(true);
    const before = await db.notes.count();
    const r = await connectMeetingApp(user, 'granola');
    expect(r).toMatchObject({ ok: true, imported: 0, switchedOff: ['Fathom'] });
    expect((await fathomStatus(user)).connected).toBe(false);
    expect((await meetingAppStatus(user, 'granola')).connected).toBe(true);
    expect(await db.notes.count()).toBe(before);
    // and back: Granola goes off
    const back = await connectFathom(user, '');
    expect(back).toMatchObject({ ok: true, switchedOff: ['Granola'] });
    expect((await meetingAppStatus(user, 'granola')).connected).toBe(false);
  });

  it('Granola, signed in: lists the meetings, reads the new ones, files them on the people by address', async () => {
    setConnectorsMockForTests(false);
    setNotesProxyUrlForTests('https://proxy.test/orbit-notes');
    const now = new Date('2026-10-20T12:00:00Z');
    // the student's Granola row, signed in (the earlier test left one switched off)
    await db.integrations
      .where('userId')
      .equals(user.id)
      .filter((i) => i.provider === 'granola')
      .delete();
    await db.integrations.put({
      id: 'int_granola_t',
      userId: user.id,
      provider: 'granola',
      status: 'active',
      scopes: [],
      syncState: {},
      connectedAt: now.toISOString(),
      accessToken: 'gra_access_token_1',
      oauth: { refreshToken: 'r1', expiresAt: '2099-01-01T00:00:00Z', clientId: 'cli_1' },
    });
    // plan 23 §4.5: a recording is filed as a chat when someone on it is a person the student has a chat with (a
    // recording of strangers asks first: notesLoop.test.ts)
    await db.people.put({
      id: 'p_jane_t',
      userId: user.id,
      displayName: 'Jane Smith',
      firstName: 'Jane',
      lastName: 'Smith',
      nameNormalized: 'jane smith',
      primaryEmail: 'jane@stripe.com',
      emails: ['jane@stripe.com'],
      relationshipType: 'unknown',
      strength: 0.3,
      interactionCount: 1,
      sources: ['gmail'],
      isHuman: true,
      tags: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await db.chats.put({
      id: 'c_jane_t',
      userId: user.id,
      personId: 'p_jane_t',
      stage: 'scheduled',
      stageEnteredAt: now.toISOString(),
      source: 'manual',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const bodies: { server: string; accessToken: string; calls: { name: string; arguments: unknown }[] }[] =
      [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://proxy.test/orbit-notes/mcp/call');
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.calls[0].name === 'list_meetings')
        return json({ ok: true, results: [{ ok: true, text: GRANOLA_LIST }] });
      return json({
        ok: true,
        results: [
          {
            ok: true,
            text: GRANOLA_LIST.replace(
              '</known_participants>',
              '</known_participants><summary>Jane walked through the payments team.</summary>',
            ),
          },
        ],
      });
    });
    const r = await syncMeetingApp(user, 'granola', { now });
    expect(r).toMatchObject({ ok: true, imported: 1 });
    expect(bodies[0]).toMatchObject({ server: 'granola', accessToken: 'gra_access_token_1' });
    expect(bodies[0]!.calls[0]!.arguments).toMatchObject({ time_range: 'custom', custom_end: '2026-10-21' });
    expect(bodies[1]!.calls[0]).toEqual({
      name: 'get_meetings',
      arguments: { meeting_ids: ['0dba4400-50f1-4262-9ac7-89cd27b79371'] },
    });
    const note = await db.notes
      .where('[source+externalId]')
      .equals(['granola_api', 'granola:0dba4400-50f1-4262-9ac7-89cd27b79371'])
      .first();
    expect(note?.rawText).toContain('Jane walked through the payments team.');
    const jane = await db.people
      .where('userId')
      .equals(user.id)
      .filter((p) => p.primaryEmail === 'jane@stripe.com')
      .first();
    expect(note?.personIds).toContain(jane?.id);
    // the next import skips it without reading it again
    const again = await syncMeetingApp(user, 'granola', { now });
    expect(again).toMatchObject({ ok: true, imported: 0 });
    expect(bodies.at(-1)!.calls[0]!.name).toBe('list_meetings');
  });

  it('Fireflies: checks the key against Fireflies itself; a refused key says so and is not kept', async () => {
    setConnectorsMockForTests(false);
    setNotesProxyUrlForTests('https://proxy.test/orbit-notes');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://api.fireflies.ai/graphql');
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
        'Bearer ff_wrong_key_123',
      );
      return new Response(JSON.stringify({ errors: [{ code: 'auth_failed', message: 'bad key' }] }), {
        status: 500,
      });
    });
    expect(await connectMeetingApp(user, 'fireflies', 'ff_wrong_key_123')).toMatchObject({
      ok: false,
      reason: 'bad_key',
      message: 'Fireflies did not accept that API key.',
    });
    expect((await meetingAppStatus(user, 'fireflies')).connected).toBe(false);
  });
});
