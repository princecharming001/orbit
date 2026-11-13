/**
 * The demo's Zoom and Google Meet, so the sample student (and the end-to-end tests) can see a call's own transcript
 * arrive without keys or a server. Connecting succeeds at once. A coffee chat held on that app's link, once it has
 * ended, has a short made-up transcript built from the people on it (and, for Zoom, an AI Companion style summary);
 * a chat on the other app's link, or one still to come, has nothing yet. A Zoom meeting for a booked call gets a
 * made-up join link.
 */
import type { CalendarEvent, CallApp, CallNote, User } from '@orbit/core';
import { callAppOfUrl } from '@orbit/core';
import { db } from '../db/schema';

const first = (name: string | undefined) => (name ?? '').trim().split(/\s+/)[0] || 'them';

/** The demo's notes for these events: one for each that ended on this app's link. */
export async function mockCallNotes(
  user: Pick<User, 'fullName' | 'firstName'>,
  app: CallApp,
  events: CalendarEvent[],
  now: Date,
): Promise<{ notes: CallNote[]; none: string[] }> {
  const notes: CallNote[] = [];
  const none: string[] = [];
  const me = user.fullName?.trim() || user.firstName || 'Me';
  for (const ev of events) {
    if (callAppOfUrl(ev.conferenceUrl) !== app || Date.parse(ev.endAt) > now.getTime()) {
      none.push(ev.id);
      continue;
    }
    const person = ev.attendeePersonIds[0] ? await db.people.get(ev.attendeePersonIds[0]) : undefined;
    const them = person?.displayName ?? ev.attendees.find((a) => !a.self)?.displayName ?? 'Guest';
    const where = person?.currentOrganizationRaw ?? 'the team';
    const transcript = [
      `${me}: Thanks so much for making the time today.`,
      `${them}: Of course, happy to help. I joined ${where} after an internship there and never left.`,
      `${me}: What does the first year on your team look like?`,
      `${them}: Mostly shipping small projects end to end. I would recommend going in with one concrete project story.`,
      `${them}: I am happy to look at your resume before applications open. Send it over this week.`,
      `${me}: Thank you, I will send it tomorrow.`,
    ].join('\n');
    notes.push({
      app,
      eventId: ev.id,
      meetingId: `mock-call-${ev.id}`,
      title: ev.title || `Coffee chat with ${them}`,
      startAt: ev.startAt,
      summary:
        app === 'zoom'
          ? `${first(them)} talked through their path to ${where} and what the first year looks like, and offered to look at ${first(me)}'s resume.\n\nNext steps:\n- Send ${first(them)} your resume`
          : undefined,
      transcript,
    });
  }
  return { notes, none };
}

/** A made-up Zoom join link for a booked call in the demo. */
export function mockZoomJoinUrl(eventId: string): string {
  let n = 0;
  for (const ch of eventId) n = (n * 31 + ch.charCodeAt(0)) % 1_000_000_000;
  return `https://zoom.us/j/8${String(n).padStart(9, '0')}`;
}
