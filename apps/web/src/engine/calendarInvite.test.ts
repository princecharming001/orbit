import type { CoffeeChat, User } from '@orbit/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import * as google from '../integrations/google';
import { canInviteFor, sendCalendarInvite } from './calendarInvite';
import { loadDemo } from './demo';
import { MANUAL_EVENT_PREFIX } from './stages';

let user: User;

beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 90_000);

afterEach(() => {
  vi.restoreAllMocks();
  setConnectorsMockForTests(undefined);
});

/** A chat with someone Orbit has an email for and nothing booked yet. */
async function chatWithEmail(): Promise<CoffeeChat> {
  const chats = await db.chats.where('userId').equals(user.id).toArray();
  for (const c of chats) {
    if (c.scheduledEventId || ['declined', 'archived'].includes(c.stage)) continue;
    const p = await db.people.get(c.personId);
    if (p?.primaryEmail) return c;
  }
  throw new Error('no chat with an email in the demo');
}

const tomorrowNoon = () => {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(12, 0, 0, 0);
  return d;
};

describe('calendar invites', () => {
  it('the sample student: saves the time and marks the invite sent, with no call to Google', async () => {
    const insert = vi.spyOn(google, 'gcalInsertEvent');
    const chat = await chatWithEmail();
    const r = await sendCalendarInvite(user, chat, { at: tomorrowNoon(), minutes: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.demo).toBe(true);
    expect(r.event.inviteSentAt).toBeTruthy();
    expect(r.meetUrl).toMatch(/^https:\/\/meet\.google\.com\//);
    expect(insert).not.toHaveBeenCalled();
    // a second press does nothing new
    const again = await sendCalendarInvite(user, (await db.chats.get(chat.id))!);
    expect(again.ok && again.event.id).toBe(r.event.id);
    expect(canInviteFor(r.event)).toBe(false);
  });

  it('a real account: asks Google for calendar access, creates the event with a Meet link and invites them', async () => {
    setConnectorsMockForTests(false);
    vi.spyOn(google, 'googleClientId').mockReturnValue('client-id');
    const ensure = vi.spyOn(google, 'ensureCalendarWrite').mockResolvedValue({
      accessToken: 't',
      expiresAt: Date.now() + 3_600_000,
      scopes: [google.CALENDAR_EVENTS_SCOPE],
    });
    const insert = vi.spyOn(google, 'gcalInsertEvent').mockResolvedValue({
      id: 'gcal-123',
      summary: 'Coffee chat',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
    });
    const chat = await chatWithEmail();
    const person = (await db.people.get(chat.personId))!;
    const at = tomorrowNoon();
    const r = await sendCalendarInvite(user, chat, { at, minutes: 20 });
    expect(r).toMatchObject({ ok: true, demo: false, meetUrl: 'https://meet.google.com/abc-defg-hij' });
    expect(ensure).toHaveBeenCalledOnce();
    const sent = insert.mock.calls[0]![0];
    expect(sent.attendees).toEqual([{ email: person.primaryEmail, displayName: person.displayName }]);
    expect(new Date(sent.endAt).getTime() - new Date(sent.startAt).getTime()).toBe(20 * 60_000);
    expect(sent.summary).toContain(person.displayName);
    // the typed-in event became the calendar's own, so the next sync updates it rather than adding a second
    const ev = (await db.events.get(r.ok ? r.event.id : ''))!;
    expect(ev.externalEventId).toBe('gcal-123');
    expect(ev.inviteSentAt).toBeTruthy();
  });

  it('says why when there is no email address, and changes nothing', async () => {
    const chats = await db.chats.where('userId').equals(user.id).toArray();
    let chat: CoffeeChat | undefined;
    for (const c of chats) if (!(await db.people.get(c.personId))?.primaryEmail) chat = c;
    expect(chat).toBeDefined();
    const before = await db.events.count();
    const r = await sendCalendarInvite(user, chat!, { at: tomorrowNoon() });
    expect(r).toMatchObject({ ok: false, reason: 'no_email' });
    expect(await db.events.count()).toBe(before);
  });

  it('a Google refusal comes back in words, and the time stays saved for a retry', async () => {
    setConnectorsMockForTests(false);
    vi.spyOn(google, 'googleClientId').mockReturnValue('client-id');
    vi.spyOn(google, 'ensureCalendarWrite').mockRejectedValue(
      new Error('Google did not give Orbit permission to add events to your calendar.'),
    );
    const chat = await chatWithEmail();
    const r = await sendCalendarInvite(user, chat, { at: tomorrowNoon() });
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    const fresh = (await db.chats.get(chat.id))!;
    const ev = (await db.events.get(fresh.scheduledEventId!))!;
    expect(ev.externalEventId.startsWith(MANUAL_EVENT_PREFIX)).toBe(true);
    expect(canInviteFor(ev)).toBe(true);
  });
});
