/**
 * The student picks one meeting notetaker: Fathom, Granola, Fireflies or Wispr Flow. Turning one on turns the others
 * off, so the same call is never filed twice from two apps. Notes already imported stay on people's pages.
 */
import { db, type IntegrationAccount } from '../db/schema';

export const MEETING_APPS = ['fathom', 'granola', 'fireflies', 'wispr'] as const;
export type MeetingAppId = (typeof MEETING_APPS)[number];

export const MEETING_APP_NAMES: Record<MeetingAppId, string> = {
  fathom: 'Fathom',
  granola: 'Granola',
  fireflies: 'Fireflies',
  wispr: 'Wispr Flow',
};

/** Where each app's meetings are filed, so the demo's made-up meetings are never filed twice under two apps. */
export const MEETING_NOTE_SOURCES = ['fathom', 'granola_api', 'fireflies', 'wispr_notetaker'] as const;

export const isMeetingAppOn = (row: IntegrationAccount | undefined): row is IntegrationAccount =>
  !!row && row.status !== 'revoked' && (!!row.accessToken || row.externalAccountId === 'demo');

/** Turn off every meeting app but `keep`; returns the names of the ones that were on. */
export async function keepOnlyMeetingApp(userId: string, keep: MeetingAppId): Promise<string[]> {
  const rows = await db.integrations
    .where('userId')
    .equals(userId)
    .filter((i) => (MEETING_APPS as readonly string[]).includes(i.provider) && i.provider !== keep)
    .toArray();
  const off: string[] = [];
  for (const r of rows) {
    if (!isMeetingAppOn(r)) continue;
    await db.integrations.update(r.id, {
      status: 'revoked',
      accessToken: undefined,
      oauth: undefined,
      externalAccountId: undefined,
      lastError: undefined,
    });
    off.push(MEETING_APP_NAMES[r.provider as MeetingAppId]);
  }
  return off;
}
