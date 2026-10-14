/**
 * Calendar v3 events.list for the sync jobs (§12.3): the initial window (2 years back, 90 days ahead, single events,
 * 2,500 a page) and the incremental read with only `syncToken` (it cannot be combined with timeMin, timeMax or q).
 * A 410 means the sync token expired; the caller runs a full resync.
 */
import { type GoogleClient, qs } from './googleApi.ts';

export const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export interface CalendarAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  organizer?: boolean;
  resource?: boolean;
}

export interface CalendarApiEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; self?: boolean };
  attendees?: CalendarAttendee[];
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { uri?: string; entryPointType?: string }[] };
  created?: string;
}

export interface CalendarPage {
  items?: CalendarApiEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export type CalendarQuery =
  | { syncToken: string; pageToken?: string }
  | { timeMin: string; timeMax: string; pageToken?: string };

export function calendarApi(client: GoogleClient, userId: string) {
  return {
    events(q: CalendarQuery): Promise<CalendarPage> {
      const params =
        'syncToken' in q
          ? { syncToken: q.syncToken, pageToken: q.pageToken, maxResults: 2500 }
          : {
              singleEvents: true,
              timeMin: q.timeMin,
              timeMax: q.timeMax,
              maxResults: 2500,
              pageToken: q.pageToken,
            };
      return client.request<CalendarPage>(userId, { url: `${CALENDAR_EVENTS_URL}${qs(params)}`, units: 1 });
    },
  };
}
