/**
 * Put a booked coffee chat on the student's Google Calendar and have Google email the invite to the other person,
 * with the call link the student picked in Settings, Scheduling: a Google Meet link (the default, made by Calendar's
 * conferenceData with hangoutsMeet), a Zoom meeting (made through the student's Zoom sign-in; Meet when Zoom cannot
 * make one), or none. It only runs from the student's own click: the Send invite button, the time dialog with its
 * box ticked, or an approved book_call in the chat. The first time, Google asks for calendar access on its own
 * (incremental consent); connecting Gmail never asks for it.
 *
 * The sample student's invites go nowhere: the event is marked as sent with a made-up Meet link, like every other
 * send in the demo.
 */
import type { CalendarEvent, CoffeeChat, User } from '@orbit/core';
import { callAppOfUrl, newId } from '@orbit/core';
import { db } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { ensureCalendarWrite, gcalInsertEvent, googleClientId } from '../integrations/google';
import { createZoomMeeting } from './callNotes';
import { scheduleChatAt, upcomingMeeting } from './move';
import { MANUAL_EVENT_PREFIX } from './stages';

export type InviteResult =
  /** `linkNote`: why the invite has another link than the one picked (Zoom could not make a meeting) */
  | { ok: true; event: CalendarEvent; meetUrl?: string; demo: boolean; linkNote?: string }
  | {
      ok: false;
      reason: 'no_email' | 'no_time' | 'already_on_calendar' | 'unavailable' | 'error';
      message: string;
    };

/** The call link's name for a sentence: "Zoom link", "Meet link", or "link". */
export function callLinkName(url: string | undefined): string {
  const app = callAppOfUrl(url);
  return app === 'zoom' ? 'Zoom link' : app === 'google_meet' ? 'Meet link' : 'link';
}

/** Whether this copy of Orbit can send calendar invites at all (Google sign-in is set up, or the demo). */
export function calendarInvitesAvailable(user: Pick<User, 'id'>): boolean {
  return usesMockConnectors(user.id) || !!googleClientId();
}

/** An event Orbit can invite for: one the student typed in, not one that came from their calendar. */
export function canInviteFor(ev: CalendarEvent | undefined): boolean {
  return !!ev && !ev.inviteSentAt && ev.externalEventId.startsWith(MANUAL_EVENT_PREFIX);
}

/** The title on both calendars: who it is with, from each side, so it reads right for either person. */
function inviteTitle(user: Pick<User, 'fullName' | 'firstName'>, otherName: string): string {
  const me = user.fullName?.trim() || user.firstName?.trim() || 'Coffee chat';
  return `Coffee chat: ${me} / ${otherName}`;
}

/**
 * Send the invite for a chat's booked time. With `at`, the time is saved first (the time dialog); without it, the
 * chat's upcoming typed-in meeting is used.
 */
export async function sendCalendarInvite(
  user: User,
  chat: CoffeeChat,
  opts: { at?: Date; minutes?: number; now?: Date } = {},
): Promise<InviteResult> {
  const person = await db.people.get(chat.personId);
  const name = person?.displayName ?? 'them';
  const email = person?.primaryEmail;
  if (!email)
    return {
      ok: false,
      reason: 'no_email',
      message: `Orbit has no email address for ${person?.firstName ?? 'them'}, so Google cannot send them an invite. Add one on their page.`,
    };
  let ev = opts.at
    ? await scheduleChatAt(user, chat, opts.at, opts.minutes ?? 30, opts.now)
    : await upcomingMeeting(chat, opts.now);
  if (!ev) return { ok: false, reason: 'no_time', message: 'Set the time of the chat first.' };
  if (ev.inviteSentAt)
    return { ok: true, event: ev, meetUrl: ev.conferenceUrl, demo: usesMockConnectors(user.id) };
  if (!ev.externalEventId.startsWith(MANUAL_EVENT_PREFIX))
    return {
      ok: false,
      reason: 'already_on_calendar',
      message: `This chat is already on your calendar, so ${person?.firstName ?? 'they'} can be invited from there.`,
    };
  const at = (opts.now ?? new Date()).toISOString();
  const choice = (await db.settings.get(user.id))?.meetingLink ?? 'meet';
  const minutes = Math.max(5, Math.round((Date.parse(ev.endAt) - Date.parse(ev.startAt)) / 60_000) || 30);
  // a Zoom meeting first, when picked: its link goes on the invite; Meet when Zoom cannot make one
  const zoomUrl =
    choice === 'zoom'
      ? await createZoomMeeting(user, {
          eventId: ev.id,
          topic: inviteTitle(user, name),
          startAt: ev.startAt,
          minutes,
        }).catch(() => undefined)
      : undefined;
  const link: 'meet' | 'zoom' | 'none' = choice === 'none' ? 'none' : zoomUrl ? 'zoom' : 'meet';
  const linkNote =
    choice === 'zoom' && !zoomUrl
      ? 'Zoom could not make a meeting, so the invite has a Google Meet link.'
      : undefined;
  if (usesMockConnectors(user.id)) {
    const demo: CalendarEvent = {
      ...ev,
      title: inviteTitle(user, name),
      attendees: [{ email, displayName: name }],
      conferenceUrl:
        link === 'zoom'
          ? zoomUrl
          : link === 'meet'
            ? `https://meet.google.com/demo-${ev.id.slice(-3)}-orbit`
            : undefined,
      inviteSentAt: at,
    };
    await db.events.put(demo);
    return { ok: true, event: demo, meetUrl: demo.conferenceUrl, demo: true, linkNote };
  }
  if (!googleClientId())
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Calendar invites need Google sign-in, which this copy of Orbit does not have yet.',
    };
  try {
    await ensureCalendarWrite();
    const created = await gcalInsertEvent({
      summary: inviteTitle(user, name),
      description: 'Set up with Orbit.',
      startAt: ev.startAt,
      endAt: ev.endAt,
      timeZone: user.timezone || undefined,
      attendees: [{ email, displayName: name }],
      requestId: newId('meet'),
      meet: link === 'meet',
      location: link === 'zoom' ? zoomUrl : undefined,
      ...(link === 'zoom' ? { description: `Set up with Orbit.\n\nJoin on Zoom: ${zoomUrl}` } : {}),
    });
    const meetUrl =
      link === 'zoom'
        ? zoomUrl
        : link === 'none'
          ? undefined
          : (created.hangoutLink ??
            created.conferenceData?.entryPoints?.find((e) => e.uri?.startsWith('https://'))?.uri);
    // the typed-in event becomes the calendar's own, so the next calendar sync updates it instead of doubling it
    ev = {
      ...ev,
      externalEventId: created.id,
      title: created.summary ?? inviteTitle(user, name),
      attendees: [{ email, displayName: name }],
      conferenceUrl: meetUrl,
      inviteSentAt: at,
    };
    await db.events.put(ev);
    return { ok: true, event: ev, meetUrl, demo: false, linkNote };
  } catch (e) {
    return {
      ok: false,
      reason: 'error',
      message: e instanceof Error ? e.message : 'Google did not add the event.',
    };
  }
}
