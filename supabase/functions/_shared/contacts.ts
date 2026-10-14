/**
 * People API v1 for the contacts sync (§1.5, §12.3): otherContacts.list (scope contacts.other.readonly) and
 * people.connections.list (scope contacts.readonly), 1,000 a page, with sync tokens. Orbit reads them only to name
 * addresses whose mail headers carry no display name. An expired sync token answers 410 (or 400 with
 * EXPIRED_SYNC_TOKEN); the caller lists everything again.
 */
import { type GoogleClient, qs } from './googleApi.ts';

export const OTHER_CONTACTS_URL = 'https://people.googleapis.com/v1/otherContacts';
export const CONNECTIONS_URL = 'https://people.googleapis.com/v1/people/me/connections';

export interface ContactPerson {
  resourceName?: string;
  names?: { displayName?: string; givenName?: string; familyName?: string }[];
  emailAddresses?: { value?: string }[];
  organizations?: { name?: string; title?: string; current?: boolean }[];
}

export interface ContactsPage {
  people: ContactPerson[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export type ContactsSource = 'otherContacts' | 'connections';

export function contactsApi(client: GoogleClient, userId: string) {
  return {
    async list(source: ContactsSource, o: { pageToken?: string; syncToken?: string }): Promise<ContactsPage> {
      const url =
        source === 'otherContacts'
          ? `${OTHER_CONTACTS_URL}${qs({
              readMask: 'names,emailAddresses',
              pageSize: 1000,
              pageToken: o.pageToken,
              requestSyncToken: true,
              syncToken: o.syncToken,
            })}`
          : `${CONNECTIONS_URL}${qs({
              personFields: 'names,emailAddresses,organizations',
              pageSize: 1000,
              pageToken: o.pageToken,
              requestSyncToken: true,
              syncToken: o.syncToken,
            })}`;
      const page = await client.request<{
        otherContacts?: ContactPerson[];
        connections?: ContactPerson[];
        nextPageToken?: string;
        nextSyncToken?: string;
      }>(userId, { url, units: 1 });
      return {
        people: page.otherContacts ?? page.connections ?? [],
        nextPageToken: page.nextPageToken,
        nextSyncToken: page.nextSyncToken,
      };
    },
  };
}
