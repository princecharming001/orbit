/**
 * How the student's drafts sound. Orbit learns it from what they actually wrote: emails they sent (Gmail), messages
 * they sent on LinkedIn (live LinkedIn), messages they edited and sent from Orbit, and examples they paste in. They
 * can then change any part by hand (greeting, sign-off, tone, length, contractions, exclamation marks, emoji,
 * phrases they use and phrases they never use, notes for Orbit), and what they set stays theirs when Orbit learns
 * again. The presets are only starting points.
 */
import type { CoachType, StyleCard, StyleChange, StyleSource, User } from '@orbit/core';
import {
  applyStyleChange,
  buildStyleCard,
  defaultStyleCard,
  mergeStyleCard,
  newId,
  presetStyleCard,
  revertStyleChange,
  type StylePreset,
} from '@orbit/core';
import { db, type StyleProfile } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { linkedInSentMessages, unipileConfigured } from '../integrations/unipile';
import { liveLinkedInAccount } from './linkedinLive';

/** How far back LinkedIn messages are read for the student's voice. */
const LINKEDIN_LOOKBACK_DAYS = 180;
/** At most this many examples are kept from any one place, newest first. */
const PER_SOURCE = 150;
/** Pasted examples kept at once. */
export const MAX_PASTED = 20;

export type SampleCounts = Record<StyleSource, number> & {
  /** live LinkedIn is connected, so its messages can be read */
  linkedinAvailable: boolean;
  /** Google is connected, so sent mail can be read */
  emailAvailable: boolean;
};

export async function styleProfile(userId: string): Promise<StyleProfile | undefined> {
  return db.styles.get(userId);
}

/** The card drafts use now: the student's own, else the preset they picked. */
export async function currentStyleCard(user: Pick<User, 'id' | 'firstName'>): Promise<StyleCard> {
  const [style, settings] = await Promise.all([db.styles.get(user.id), db.settings.get(user.id)]);
  return style?.card ?? defaultStyleCard(settings?.tonePreset ?? 'warm', user.firstName);
}

async function sentEmails(userId: string): Promise<string[]> {
  const sent = await db.messages
    .where('userId')
    .equals(userId)
    .filter((m) => m.direction === 'outbound' && !m.isAutomated)
    .toArray();
  return sent
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
    .slice(0, PER_SOURCE)
    .map((m) => m.bodyText);
}

/** Messages the student changed before sending from Orbit: the edits are their voice, the rest was Orbit's. */
async function editedFromOrbit(userId: string): Promise<string[]> {
  const out = await db.outbound
    .where('userId')
    .equals(userId)
    .filter(
      (o) =>
        (o.status === 'sent' || o.status === 'handed_off') &&
        !!o.bodyFinal &&
        o.bodyFinal.trim() !== o.bodyDraft.trim(),
    )
    .toArray();
  return out.slice(-PER_SOURCE).map((o) => o.bodyFinal!);
}

async function linkedInReady(
  user: Pick<User, 'id'>,
): Promise<{ accountId: string; token?: string } | undefined> {
  const row = await liveLinkedInAccount(user.id);
  if (!row || row.status === 'revoked' || !row.externalAccountId) return undefined;
  if (usesMockConnectors(user.id)) return { accountId: row.externalAccountId };
  if (!unipileConfigured() || !row.accessToken) return undefined;
  return { accountId: row.externalAccountId, token: row.accessToken };
}

/** The demo student's LinkedIn messages: short, friendly, the way students write there. */
const DEMO_LINKEDIN = [
  'Hi Maya! Thanks so much for accepting. Would love to hear how you made the jump to Stripe when you have a sec.',
  'Hey Diego, saw your post on the infra team, super cool stuff. Any chance you have 15 min this week?',
  'Thanks again for the chat yesterday, really appreciated the advice on the take-home!',
  'Hi Priya, fellow Cornellian here :) Would love to learn more about your path to Stripe.',
  'Totally understand, thanks for letting me know! Good luck with the launch.',
];

async function linkedInMessages(user: Pick<User, 'id'>, now: Date): Promise<string[] | undefined> {
  const ready = await linkedInReady(user);
  if (!ready) return undefined;
  if (usesMockConnectors(user.id)) return DEMO_LINKEDIN;
  const r = await linkedInSentMessages(
    ready.accountId,
    new Date(now.getTime() - LINKEDIN_LOOKBACK_DAYS * 86_400_000),
    { token: ready.token },
  );
  return r.ok ? r.value.slice(0, PER_SOURCE).map((m) => m.text) : undefined;
}

/** How many examples Orbit has in each place right now (LinkedIn is counted when Orbit learns, not before). */
export async function sampleCounts(user: Pick<User, 'id'>): Promise<SampleCounts> {
  const [emails, orbit, style, google, linkedin] = await Promise.all([
    sentEmails(user.id),
    editedFromOrbit(user.id),
    db.styles.get(user.id),
    db.integrations
      .where('userId')
      .equals(user.id)
      .filter((i) => i.provider === 'google' && i.status !== 'revoked')
      .first(),
    linkedInReady(user),
  ]);
  return {
    email: emails.length,
    orbit: orbit.length,
    pasted: style?.samples?.length ?? 0,
    linkedin: style?.card.sources?.linkedin ?? 0,
    linkedinAvailable: !!linkedin,
    emailAvailable: !!google || emails.length > 0,
  };
}

export type LearnResult =
  | { ok: true; card: StyleCard; learnedFrom: number; sources: Partial<Record<StyleSource, number>> }
  | { ok: false; reason: string };

/**
 * Learn the student's voice from everything Orbit can read, and lay it over what they set by hand. With too few
 * examples it says so and changes nothing.
 */
export async function learnStyle(
  user: Pick<User, 'id' | 'firstName'>,
  opts: { now?: Date } = {},
): Promise<LearnResult> {
  const now = opts.now ?? new Date();
  const [style, settings, emails, orbit, linkedin] = await Promise.all([
    db.styles.get(user.id),
    db.settings.get(user.id),
    sentEmails(user.id),
    editedFromOrbit(user.id),
    linkedInMessages(user, now),
  ]);
  const samples = [
    ...emails.map((text) => ({ text, source: 'email' as const })),
    ...(linkedin ?? []).map((text) => ({ text, source: 'linkedin' as const })),
    ...orbit.map((text) => ({ text, source: 'orbit' as const })),
    ...(style?.samples ?? []).map((text) => ({ text, source: 'pasted' as const })),
  ];
  const learned = buildStyleCard(samples, user.firstName, settings?.tonePreset ?? 'warm');
  if (learned.builtFromCount === 0)
    return {
      ok: false,
      reason:
        'Orbit needs at least three messages you wrote. Connect Gmail or LinkedIn, or paste a few messages you sent.',
    };
  const card = mergeStyleCard(learned, style?.card);
  await db.styles.put({ ...style, userId: user.id, card, updatedAt: now.toISOString() });
  return { ok: true, card, learnedFrom: learned.builtFromCount, sources: learned.sources ?? {} };
}

/** Change parts of the style by hand. Whatever is set here wins over what Orbit learns later. */
export async function updateStyle(
  user: Pick<User, 'id' | 'firstName'>,
  patch: Partial<StyleCard>,
  now = new Date(),
): Promise<StyleCard> {
  const style = await db.styles.get(user.id);
  const base = style?.card ?? (await currentStyleCard(user));
  const card: StyleCard = { ...base, ...patch, custom: true };
  await db.styles.put({ ...style, userId: user.id, card, updatedAt: now.toISOString() });
  return card;
}

/** Start over from a preset (Warm, Direct, Formal), keeping the "never say" list and notes. */
export async function applyStylePreset(
  user: Pick<User, 'id' | 'firstName'>,
  preset: StylePreset,
  now = new Date(),
): Promise<StyleCard> {
  const style = await db.styles.get(user.id);
  const card = presetStyleCard(preset, user.firstName, style?.card);
  await db.settings.update(user.id, { tonePreset: preset });
  await db.styles.put({ ...style, userId: user.id, card, updatedAt: now.toISOString() });
  return card;
}

/** Add an example of how the student writes (an email or message they sent before). */
export async function addStyleSample(user: Pick<User, 'id' | 'firstName'>, text: string, now = new Date()) {
  const clean = text.trim();
  if (clean.split(/\s+/).length < 4)
    return { ok: false as const, reason: 'Paste a whole message, at least a sentence.' };
  const style = await db.styles.get(user.id);
  const samples = [clean, ...(style?.samples ?? []).filter((s) => s !== clean)].slice(0, MAX_PASTED);
  const card = style?.card ?? (await currentStyleCard(user));
  await db.styles.put({ ...style, userId: user.id, card, samples, updatedAt: now.toISOString() });
  return { ok: true as const, count: samples.length };
}

export async function removeStyleSample(userId: string, index: number): Promise<void> {
  const style = await db.styles.get(userId);
  if (!style?.samples) return;
  await db.styles.put({ ...style, samples: style.samples.filter((_, i) => i !== index) });
}

// ---------- the outreach coach's tuning log ----------

/** One change the coach made to the card, with what it was before, so it can be undone on its own. */
export interface StyleTuningEntry {
  id: string;
  at: string;
  /** who asked for it: the student's own words, a finding in the coach's review, or Claude reading their words */
  by: 'you' | 'coach' | 'claude';
  /** what they said ("shorter"), or the finding it fixes */
  said: string;
  /** what changed: "about 40 words, was 60" */
  summary: string;
  change: StyleChange;
  /** the card's values for the changed fields before this change */
  before: Partial<StyleCard>;
  /** the kind of outreach on screen when it was made */
  type?: CoachType;
  undoneAt?: string;
}

/** Entries kept per student, newest first. */
export const STYLE_TUNING_MAX = 60;
export const styleTuningKey = (userId: string) => `styleTuning:${userId}`;

export async function styleTuningLog(userId: string): Promise<StyleTuningEntry[]> {
  const row = await db.kv.get(styleTuningKey(userId));
  return Array.isArray(row?.value) ? (row.value as StyleTuningEntry[]) : [];
}

/**
 * Apply the coach's changes to the card (as the student's own, so learning again keeps them) and log each one.
 * Changes the card already reflects are skipped; the result lists only what was logged.
 */
export async function tuneStyle(
  user: Pick<User, 'id' | 'firstName'>,
  changes: StyleChange[],
  meta: { by: StyleTuningEntry['by']; said: string; type?: CoachType },
  now = new Date(),
): Promise<{ card: StyleCard; entries: StyleTuningEntry[] }> {
  let card = await currentStyleCard(user);
  const entries: StyleTuningEntry[] = [];
  let patch: Partial<StyleCard> = {};
  for (const change of changes) {
    const a = applyStyleChange(card, change, user.firstName);
    if (!a) continue;
    const before = Object.fromEntries(
      Object.keys(a.patch).map((k) => [k, card[k as keyof StyleCard]]),
    ) as Partial<StyleCard>;
    card = { ...card, ...a.patch };
    patch = { ...patch, ...a.patch };
    entries.push({
      id: newId('tune'),
      at: now.toISOString(),
      by: meta.by,
      said: meta.said.trim().slice(0, 200),
      summary: a.summary,
      change,
      before,
      type: meta.type,
    });
  }
  if (!entries.length) return { card, entries };
  card = await updateStyle(user, patch, now);
  const log = await styleTuningLog(user.id);
  await db.kv.put({
    key: styleTuningKey(user.id),
    value: [...[...entries].reverse(), ...log].slice(0, STYLE_TUNING_MAX),
  });
  return { card, entries };
}

/** Undo one logged change: a phrase or note is taken back out, a setting goes back to what it was. */
export async function undoStyleTuning(
  user: Pick<User, 'id' | 'firstName'>,
  entryId: string,
  now = new Date(),
): Promise<boolean> {
  const log = await styleTuningLog(user.id);
  const entry = log.find((e) => e.id === entryId);
  if (!entry || entry.undoneAt) return false;
  const card = await currentStyleCard(user);
  await updateStyle(user, revertStyleChange(card, entry.change, entry.before), now);
  await db.kv.put({
    key: styleTuningKey(user.id),
    value: log.map((e) => (e.id === entryId ? { ...e, undoneAt: now.toISOString() } : e)),
  });
  return true;
}
