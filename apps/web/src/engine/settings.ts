import type { ProfileSettingsRequest, RecruitingGoals, TargetCompany, User, UserSettings } from '@orbit/core';
import { buildStyleCard } from '@orbit/core';
import { db } from '../db/schema';
import { callApi, isServerUser } from '../integrations/orbitApi';

// ---------- what the server reads ----------

/** Per account: what is still to send, and the sends one after another (typing a link saves on every key). */
const profileSends = new Map<string, { pending?: ProfileSettingsRequest; chain: Promise<boolean> }>();

/**
 * Account mode: the settings the server's drafting and sending read (the postal address sales email needs, the
 * booking link, the time zone send windows follow) go to /settings/profile as well as into this browser. Changes
 * made while a send is out are merged into the next one, so the server ends on the latest value. Best effort: the
 * local copy is already saved, and a refusal (an http link, a zone the server does not know) changes nothing here.
 * Resolves to whether the server took the send that carried this change; false outside account mode.
 */
export function pushProfileSettings(userId: string, p: ProfileSettingsRequest): Promise<boolean> {
  if (!isServerUser(userId) || !Object.keys(p).length) return Promise.resolve(false);
  let q = profileSends.get(userId);
  if (!q) {
    q = { chain: Promise.resolve(false) };
    profileSends.set(userId, q);
  }
  const queue = q;
  queue.pending = { ...queue.pending, ...p };
  queue.chain = queue.chain.then(async (previous) => {
    const body = queue.pending;
    if (!body) return previous;
    queue.pending = undefined;
    return (await callApi('/settings/profile', body)).ok;
  });
  return queue.chain;
}

// ---------- profile ----------

/** "Alex Rivera" -> first "Alex", last "Rivera" (everything after the first word). */
export function splitFullName(fullName: string): { fullName: string; firstName: string; lastName: string } {
  const clean = fullName.trim();
  const [first, ...rest] = clean.split(/\s+/);
  return { fullName: clean, firstName: first ?? '', lastName: rest.join(' ') };
}

export type ProfilePatch = Partial<
  Pick<
    User,
    | 'fullName'
    | 'email'
    | 'school'
    | 'schoolDomain'
    | 'graduationYear'
    | 'degree'
    | 'majors'
    | 'currentCity'
    | 'linkedinUrl'
    | 'timezone'
  >
>;

/**
 * Save profile fields (Settings autosave, the About you setup step, the chat). The name is split into first and
 * last for signatures; empty optional fields are cleared. A missing name is refused: it signs every message.
 */
export async function updateProfile(userId: string, patch: ProfilePatch): Promise<User | undefined> {
  const user = await db.users.get(userId);
  if (!user) return undefined;
  const changes: Partial<User> = { ...patch };
  if (patch.fullName !== undefined) {
    if (!patch.fullName.trim()) return undefined;
    Object.assign(changes, splitFullName(patch.fullName));
  }
  if (patch.email !== undefined) changes.email = patch.email.trim();
  if (patch.school !== undefined) changes.school = patch.school.trim();
  if ('schoolDomain' in patch) changes.schoolDomain = patch.schoolDomain?.trim().toLowerCase() || undefined;
  if ('linkedinUrl' in patch) changes.linkedinUrl = patch.linkedinUrl?.trim() || undefined;
  if ('graduationYear' in patch) changes.graduationYear = patch.graduationYear || undefined;
  if ('degree' in patch) changes.degree = patch.degree?.trim() || undefined;
  if ('currentCity' in patch) changes.currentCity = patch.currentCity?.trim() || undefined;
  if (patch.majors !== undefined) changes.majors = patch.majors.map((m) => m.trim()).filter(Boolean);
  if (patch.timezone !== undefined && !patch.timezone.trim()) delete changes.timezone;
  await db.users.update(userId, changes);
  if (changes.timezone && changes.timezone !== user.timezone)
    await pushProfileSettings(userId, { timezone: changes.timezone });
  return db.users.get(userId);
}

/** "CS, Economics" -> ["CS", "Economics"], as the forms split lists. */
export function splitList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

// ---------- goals ----------

/** How many first messages a week each ambition level means (the setup step's choice). */
export const AMBITION_WEEKLY_TARGET: Record<1 | 2 | 3, number> = { 1: 2, 2: 4, 3: 7 };

export type GoalsPatch = Partial<Omit<RecruitingGoals, 'userId'>>;

/**
 * Save goals (Settings autosave, the setup step, the chat). Fields not given keep their stored value. With
 * `applyAmbition` the weekly first-message target follows the ambition, as the setup step does.
 */
export async function saveGoals(
  userId: string,
  patch: GoalsPatch,
  opts: { applyAmbition?: boolean } = {},
): Promise<RecruitingGoals> {
  const cur = await db.goals.get(userId);
  const goals: RecruitingGoals = {
    userId,
    cycleLabel: (patch.cycleLabel ?? cur?.cycleLabel ?? '').trim() || 'This cycle',
    targetRoles: patch.targetRoles ?? cur?.targetRoles ?? [],
    targetFunctions: patch.targetFunctions ?? cur?.targetFunctions ?? [],
    targetIndustries: patch.targetIndustries ?? cur?.targetIndustries ?? [],
    targetLocations: patch.targetLocations ?? cur?.targetLocations ?? [],
    freeText: patch.freeText ?? cur?.freeText,
    ambition: patch.ambition ?? cur?.ambition ?? 2,
  };
  await db.goals.put(goals);
  if (opts.applyAmbition)
    await db.settings.update(userId, { weeklyOutreachTarget: AMBITION_WEEKLY_TARGET[goals.ambition] });
  return goals;
}

// ---------- target companies ----------

export async function setTargetPriority(id: string, priority: 1 | 2 | 3): Promise<boolean> {
  return (await db.targetCompanies.update(id, { priority })) > 0;
}

/** The application status drives the applied, interviewing and offer update cards, dated from this change. */
export async function setTargetStatus(
  id: string,
  status: TargetCompany['status'],
  now = new Date(),
): Promise<boolean> {
  return (await db.targetCompanies.update(id, { status, statusChangedAt: now.toISOString() })) > 0;
}

export async function setTargetDeadline(id: string, deadline: string | undefined): Promise<boolean> {
  return (await db.targetCompanies.update(id, { deadline: deadline || undefined })) > 0;
}

/** Remove a target; the row comes back with restoreTargetCompany (the Undo on the toast). */
export async function removeTargetCompany(id: string): Promise<TargetCompany | undefined> {
  const t = await db.targetCompanies.get(id);
  if (!t) return undefined;
  await db.targetCompanies.delete(id);
  return t;
}

export async function restoreTargetCompany(t: TargetCompany): Promise<void> {
  await db.targetCompanies.put(t);
}

// ---------- limits, schedule, tone ----------

export type LimitsPatch = Partial<
  Pick<
    UserSettings,
    | 'weeklyOutreachTarget'
    | 'perPersonCooldownHours'
    | 'dailySendCapGmail'
    | 'dailySendCapLinkedin'
    | 'maxBumps'
    | 'warmUpEnabled'
    | 'warmUpDays'
  >
>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The ranges the Limits page allows for each setting. */
export const LIMIT_RANGES = {
  weeklyOutreachTarget: [1, 350],
  perPersonCooldownHours: [0, 24 * 90],
  dailySendCapGmail: [1, 50],
  dailySendCapLinkedin: [1, 30],
  maxBumps: [0, 2],
  warmUpDays: [2, 10],
} as const;

/** Save sending limits and the warm-up settings, kept inside the ranges the page allows. */
export async function updateLimits(userId: string, patch: LimitsPatch): Promise<UserSettings | undefined> {
  const changes: Partial<UserSettings> = {};
  for (const key of Object.keys(LIMIT_RANGES) as (keyof typeof LIMIT_RANGES)[]) {
    const v = patch[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const [lo, hi] = LIMIT_RANGES[key];
    changes[key] = clamp(Math.round(v), lo, hi);
  }
  if (typeof patch.warmUpEnabled === 'boolean') changes.warmUpEnabled = patch.warmUpEnabled;
  if (Object.keys(changes).length) await db.settings.update(userId, changes);
  return db.settings.get(userId);
}

export async function setTonePreset(userId: string, tonePreset: UserSettings['tonePreset']): Promise<void> {
  await db.settings.update(userId, { tonePreset });
}

/** The booking link drafts include when proposing times; an empty value removes it. */
export async function setSchedulingLink(userId: string, link: string | undefined): Promise<void> {
  const clean = link?.trim() || undefined;
  const before = (await db.settings.get(userId))?.schedulingLink;
  await db.settings.update(userId, { schedulingLink: clean });
  if (clean !== before) await pushProfileSettings(userId, { schedulingLink: clean ?? null });
}

export async function setBriefTime(userId: string, briefTimeLocal: string): Promise<void> {
  await db.settings.update(userId, { briefTimeLocal });
}

/** The setup step's preferences, saved together. */
export async function savePreferences(
  userId: string,
  prefs: Partial<Pick<UserSettings, 'briefTimeLocal' | 'tonePreset' | 'schedulingLink' | 'warmUpEnabled'>>,
): Promise<void> {
  const changes: Partial<UserSettings> = { ...prefs };
  if ('schedulingLink' in prefs) changes.schedulingLink = prefs.schedulingLink?.trim() || undefined;
  await db.settings.update(userId, changes);
  if ('schedulingLink' in prefs)
    await pushProfileSettings(userId, { schedulingLink: changes.schedulingLink ?? null });
}

/** Close a first-run hint for good. */
export async function dismissHint(userId: string, id: string): Promise<void> {
  const cur = (await db.settings.get(userId))?.dismissedHints ?? [];
  if (!cur.includes(id)) await db.settings.update(userId, { dismissedHints: [...cur, id] });
}

// ---------- writing style ----------

export const STYLE_MIN_SENT = 5;

/**
 * Learn the student's style from the emails they sent (Google only). Needs at least five; otherwise says so and
 * changes nothing.
 */
export async function learnStyleFromSent(
  user: Pick<User, 'id' | 'firstName'>,
  now = new Date(),
): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
  const sent = await db.messages
    .where('userId')
    .equals(user.id)
    .filter((m) => m.direction === 'outbound' && !m.isAutomated)
    .toArray();
  if (sent.length < STYLE_MIN_SENT)
    return {
      ok: false,
      reason: `Orbit needs at least ${STYLE_MIN_SENT} emails you sent to learn from. Sync Google again later.`,
    };
  const settings = await db.settings.get(user.id);
  await db.styles.put({
    userId: user.id,
    card: buildStyleCard(
      sent.map((m) => m.bodyText),
      user.firstName,
      settings?.tonePreset,
    ),
    updatedAt: now.toISOString(),
  });
  return { ok: true, count: sent.length };
}

/** Forget the learned style card: drafts follow the picked tone again. */
export async function forgetLearnedStyle(userId: string): Promise<boolean> {
  const had = await db.styles.get(userId);
  if (!had) return false;
  await db.styles.delete(userId);
  return true;
}
