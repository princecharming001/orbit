/**
 * The student's rules for what Orbit may do with their outreach (plan 16 §8.3, §9.3, §14.3): the autonomy level
 * (overall and per goal), a pause until a date, and the postal address commercial email needs. In account mode the
 * server enforces them; the browser keeps a copy in the settings row for the screens and the chat.
 */
import type { Goal, User, UserSettings } from '@orbit/core';
import { db } from '../db/schema';
import { callApi, isAccountMode, isServerUser, NO_SERVER, SIGN_IN_FIRST } from '../integrations/orbitApi';
import { writeFromServer } from './serverSync';
import { pushProfileSettings } from './settings';

export type AutonomyLevel = 0 | 1 | 2;

/** What each level means, in the student's words. */
export const AUTONOMY_TEXT: Record<AutonomyLevel, { title: string; body: string }> = {
  0: {
    title: 'Draft only',
    body: 'Orbit writes drafts. You send every message yourself.',
  },
  1: {
    title: 'Send after I approve',
    body: 'One tap approves a draft, and Orbit sends it in the next good window. You can cancel until then.',
  },
  2: {
    title: 'Send simple replies for me',
    body: 'Orbit may answer on its own only inside an email thread where you both have written, and only to confirm a time or say thanks, a few times a day at most. First messages and LinkedIn always wait for you.',
  },
};

/** The outreach fields kept beside the v1 settings (the core type does not carry them). */
export interface OutreachSettings {
  autonomyLevel?: AutonomyLevel;
  /** YYYY-MM-DD: nothing is drafted or sent until then */
  quietUntil?: string;
  /** the sender's postal address, required before the first sales email (CAN-SPAM) */
  postalAddress?: string;
}

type SettingsRow = UserSettings & OutreachSettings;

type Fail = { ok: false; message: string };
const notHere = (): Fail => ({ ok: false, message: isAccountMode() ? SIGN_IN_FIRST : NO_SERVER });

export async function outreachSettings(userId: string): Promise<OutreachSettings> {
  const row = (await db.settings.get(userId)) as SettingsRow | undefined;
  return {
    autonomyLevel: row?.autonomyLevel ?? 0,
    quietUntil: row?.quietUntil,
    postalAddress: row?.postalAddress,
  };
}

async function patch(userId: string, p: Partial<OutreachSettings>): Promise<void> {
  await db.settings.update(userId, p as Partial<UserSettings>);
}

/** Set the autonomy level, overall or for one goal. */
export async function setAutonomy(
  user: Pick<User, 'id'>,
  level: AutonomyLevel,
  goalId?: string,
): Promise<{ ok: true; goal?: Goal } | Fail> {
  if (!isServerUser(user.id)) return notHere();
  const goal = goalId ? await db.userGoals.get(goalId) : undefined;
  if (goalId && (!goal || goal.userId !== user.id || goal.deletedAt))
    return { ok: false, message: 'Orbit has no goal with that id. List the goals first.' };
  const r = await callApi('/settings/autonomy', { level, ...(goalId ? { goalId } : {}) });
  if (!r.ok) return { ok: false, message: r.message };
  if (goal) {
    const next = { ...goal, autonomyLevel: level, updatedAt: new Date().toISOString() };
    await writeFromServer('goals', [next], user.id);
    return { ok: true, goal: next };
  }
  await patch(user.id, { autonomyLevel: level });
  return { ok: true };
}

/** Pause all outreach until a date (YYYY-MM-DD), or resume with null. */
export async function pauseOutreach(
  user: Pick<User, 'id'>,
  until: string | null,
): Promise<{ ok: true; until: string | null } | Fail> {
  if (!isServerUser(user.id)) return notHere();
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until))
    return { ok: false, message: 'Give the date as YYYY-MM-DD.' };
  const r = await callApi('/settings/pause', { until });
  if (!r.ok) return { ok: false, message: r.message };
  await patch(user.id, { quietUntil: until ?? undefined });
  return { ok: true, until };
}

/** Keep the postal address sales emails must carry; in account mode the server's copy is the one drafts read. */
export async function setPostalAddress(userId: string, address: string): Promise<void> {
  const clean = address.trim() || undefined;
  const before = (await outreachSettings(userId)).postalAddress;
  await patch(userId, { postalAddress: clean });
  if (clean !== before) await pushProfileSettings(userId, { postalAddress: clean ?? null });
}
