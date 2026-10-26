/**
 * The trust ladder (plan 23 §4.9): Orbit offers to send a kind of message on its own only once the student has
 * shown, by approving ten of that kind without changing a word, that they would send what Orbit writes anyway. Bumps
 * first, then thank-yous, then scheduling replies, each earned separately. The student says yes or no per kind; two
 * edits to a handed-over kind in a month ask again; Settings shows where each kind stands and switches it.
 *
 * What it sends: a card's draft of a handed-over kind, by Gmail only (LinkedIn never sends without a tap), after the
 * same check every approval runs, only when the person has not replied since the card was raised, at most five a day,
 * only to someone the student knows (a tie score of 40 or more), in the recipient's morning send window, and never
 * sooner than a minute from now, so there is always a minute to undo it.
 */
import {
  AUTO_SEND_DAILY_CAP,
  AUTO_SEND_MIN_SCORE,
  type MessageKind,
  nextSendWindow,
  type Person,
  type Suggestion,
  type User,
} from '@orbit/core';
import { db } from '../db/schema';
import { flagOn } from './flags';
import { zoneFromLocation } from './timezone';

/** The kinds the ladder offers, in the order it offers them. */
export const LADDER_KINDS = ['bump', 'thank_you', 'schedule'] as const satisfies readonly MessageKind[];
export type LadderKind = (typeof LADDER_KINDS)[number];
/** Approvals without an edit that earn the offer. */
export const OFFER_AT = 10;
/** Edits to a handed-over kind within this many days ask whether to keep it. */
export const RECHECK_EDITS = 2;
const RECHECK_DAYS = 30;
/** The undo window for what Orbit sends on its own (taps keep their own, shorter one). */
export const AUTO_UNDO_MS = 60_000;
const DAY = 86_400_000;

export const LADDER_WORDS: Record<LadderKind, { many: string; one: string; title: string }> = {
  bump: { many: 'bumps', one: 'bump', title: 'Bumps' },
  thank_you: { many: 'thank-yous', one: 'thank-you', title: 'Thank-yous' },
  schedule: { many: 'scheduling replies', one: 'scheduling reply', title: 'Scheduling replies' },
};

export interface Streak {
  /** approvals without an edit since the last edit */
  unedited: number;
  /** edits in the last 30 days */
  edited: number;
  since?: string;
}

/** Per kind: the approvals in a row without an edit, and the recent edits (Orbit's own sends never count). */
export async function approvalStreaks(userId: string, now = new Date()): Promise<Record<LadderKind, Streak>> {
  const rows = (await db.feedback.where('userId').equals(userId).toArray())
    .filter((f) => (f.kind === 'approve' || f.kind === 'edit') && !!f.outboundMessageId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const msgs = new Map(
    (await db.outbound.bulkGet(rows.map((r) => r.outboundMessageId!)))
      .filter((m) => !!m)
      .map((m) => [m!.id, m!]),
  );
  const out = Object.fromEntries(LADDER_KINDS.map((k) => [k, { unedited: 0, edited: 0 }])) as Record<
    LadderKind,
    Streak
  >;
  for (const r of rows) {
    const m = msgs.get(r.outboundMessageId!);
    if (!m || m.autoSent || !(LADDER_KINDS as readonly string[]).includes(m.kind)) continue;
    const s = out[m.kind as LadderKind];
    if (r.kind === 'edit') {
      s.unedited = 0;
      s.since = undefined;
      if (now.getTime() - Date.parse(r.createdAt) < RECHECK_DAYS * DAY) s.edited++;
    } else {
      s.unedited++;
      s.since ??= r.createdAt;
    }
  }
  return out;
}

const offerKey = (kind: LadderKind) => `trust:${kind}`;
const recheckKey = (kind: LadderKind) => `trust:recheck:${kind}`;

/**
 * Raise the ladder's cards: the offer for the first kind (in order) that earned it and was never answered, and "Keep
 * sending on your own?" for a handed-over kind the student edited twice this month.
 */
export async function raiseTrustCards(user: Pick<User, 'id'>, now = new Date()): Promise<void> {
  if (!(await flagOn('trustLadder'))) return;
  const [streaks, settings] = await Promise.all([approvalStreaks(user.id, now), db.settings.get(user.id)]);
  const auto = new Set(settings?.autoKinds ?? []);
  const { upsertSuggestions } = await import('./brief');
  // one offer at a time, in the ladder's order
  let offering = await db.suggestions
    .where('kind')
    .equals('trust_offer')
    .filter((x) => x.userId === user.id && x.status === 'pending' && !x.payload.recheck)
    .count();
  for (const kind of LADDER_KINDS) {
    const w = LADDER_WORDS[kind];
    if (auto.has(kind)) {
      // after a Keep, only new edits ask again
      const kept = Number((await db.kv.get(`trust:kept:${user.id}:${kind}`))?.value ?? 0);
      if (streaks[kind].edited < RECHECK_EDITS || streaks[kind].edited <= kept) continue;
      const had = await db.suggestions.where('dedupeKey').equals(recheckKey(kind)).first();
      if (had && had.status === 'pending') continue;
      if (had) await db.suggestions.delete(had.id);
      await upsertSuggestions(
        user.id,
        [
          {
            kind: 'trust_offer',
            dedupeKey: recheckKey(kind),
            reasonText: `You changed ${streaks[kind].edited} ${w.many} Orbit wrote this month. Keep sending ${w.many} on your own?`,
            signals: { edited: streaks[kind].edited },
            payload: { messageKind: kind, recheck: true },
            urgency: 0.6,
            goalRelevance: 0.4,
            confidence: 1,
            priorityScore: 0.6,
          },
        ],
        now,
      );
      continue;
    }
    if (streaks[kind].unedited < OFFER_AT || offering) continue;
    // an offer answered no is not made again
    if (await db.suggestions.where('dedupeKey').equals(offerKey(kind)).first()) continue;
    await upsertSuggestions(
      user.id,
      [
        {
          kind: 'trust_offer',
          dedupeKey: offerKey(kind),
          reasonText: `You've approved ${streaks[kind].unedited} ${w.many} without changing a word. Want Orbit to send ${w.many} on its own? You'll see each one after it goes, and can undo for a minute.`,
          signals: { unedited: streaks[kind].unedited },
          payload: { messageKind: kind },
          urgency: 0.5,
          goalRelevance: 0.4,
          confidence: 1,
          priorityScore: 0.55,
        },
      ],
      now,
    );
    offering++;
  }
}

/** The student's answer on a ladder card: yes hands the kind over (or keeps it), no keeps asking. */
export async function answerTrustOffer(
  user: Pick<User, 'id'>,
  s: Suggestion,
  yes: boolean,
  now = new Date(),
) {
  const kind = s.payload.messageKind as LadderKind;
  const settings = await db.settings.get(user.id);
  const auto = new Set(settings?.autoKinds ?? []);
  if (yes) auto.add(kind);
  else auto.delete(kind);
  await db.settings.update(user.id, { autoKinds: [...auto] });
  await db.suggestions.update(s.id, { status: 'done', decidedAt: now.toISOString() });
  if (yes && s.payload.recheck)
    await db.kv.put({ key: `trust:kept:${user.id}:${kind}`, value: Number(s.signals.edited ?? 0) });
  // "Ask me again" after a recheck starts the streak over: the next offer comes after ten more untouched approvals
  if (!yes && s.payload.recheck) {
    const offer = await db.suggestions.where('dedupeKey').equals(offerKey(kind)).first();
    if (offer) await db.suggestions.delete(offer.id);
    await db.feedback.add({
      id: `fb_trust_${kind}_${now.getTime()}`,
      userId: user.id,
      kind: 'edit',
      reason: `trust:reset:${kind}`,
      createdAt: now.toISOString(),
    });
  }
}

/** Turn a kind on or off from Settings. */
export async function setAutoKind(userId: string, kind: LadderKind, on: boolean): Promise<void> {
  const settings = await db.settings.get(userId);
  const auto = new Set(settings?.autoKinds ?? []);
  if (on) auto.add(kind);
  else auto.delete(kind);
  await db.settings.update(userId, { autoKinds: [...auto] });
}

/** A person's time zone: kept on them, else read from where they are, else undefined. */
export function personZone(p: Pick<Person, 'timezone' | 'location'>): string | undefined {
  return p.timezone ?? zoneFromLocation(p.location);
}

/** What Orbit sends on its own on the day `at` falls on (local), for the cap of five a day. */
async function autoSentOn(userId: string, at: Date): Promise<number> {
  const day = at.toDateString();
  return db.outbound
    .where('userId')
    .equals(userId)
    .filter(
      (o) => !!o.autoSent && o.status !== 'draft' && !!o.sendAt && new Date(o.sendAt).toDateString() === day,
    )
    .count();
}

export type AutoSendOutcome = { sent: true; sendAt: string } | { sent: false; why: string };

/**
 * A card was raised with a draft: when its kind is handed over and every rule holds, Orbit approves it itself and
 * queues it for the recipient's morning. Otherwise the card waits for the student as always.
 */
export async function maybeAutoSend(
  user: User,
  s: Suggestion,
  now = new Date(),
  messageId = s.outboundMessageId,
): Promise<AutoSendOutcome> {
  const r = await autoSendOnce(user, s, now, messageId);
  // the last answer is kept for the ladder's watch (plan 23 §6.5): why a handed-over kind still waited, when it did
  if (!(r.sent === false && (r.why === 'off' || r.why === 'kind not handed over'))) {
    const key = `trust:last:${user.id}`;
    const had = (await db.kv.get(key))?.value;
    const row = { ...r, at: now.toISOString(), messageId };
    await db.kv
      .put({ key, value: [...(Array.isArray(had) ? had : []), row].slice(-10) })
      .catch(() => undefined);
  }
  return r;
}

async function autoSendOnce(
  user: User,
  s: Suggestion,
  now: Date,
  messageId: string | undefined,
): Promise<AutoSendOutcome> {
  const settings = await db.settings.get(user.id);
  if (!settings?.autoKinds?.length || !(await flagOn('trustLadder'))) return { sent: false, why: 'off' };
  const msg = messageId ? await db.outbound.get(messageId) : undefined;
  if (!msg || msg.status !== 'draft') return { sent: false, why: 'no draft' };
  if (!settings.autoKinds.includes(msg.kind)) return { sent: false, why: 'kind not handed over' };
  // LinkedIn never sends without a tap
  if (msg.channel !== 'gmail') return { sent: false, why: 'not Gmail' };
  if (msg.needsInput?.length) return { sent: false, why: 'needs a line from the student' };
  const person = await db.people.get(msg.personId);
  if (!person || person.doNotContact) return { sent: false, why: 'person' };
  const score = person.tieScore ?? Math.round(person.strength * 100);
  if (score < AUTO_SEND_MIN_SCORE) return { sent: false, why: `score ${score}` };
  // a reply since the card was raised changes what to say: the student decides
  const chat = msg.chatId ? await db.chats.get(msg.chatId) : undefined;
  if (chat?.lastInboundAt && chat.lastInboundAt > s.createdAt) return { sent: false, why: 'they replied' };
  const zone = personZone(person) ?? user.timezone;
  const window = Date.parse(nextSendWindow(now, zone, 'gmail').notBefore);
  const sendAt = new Date(Math.max(window, now.getTime() + AUTO_UNDO_MS));
  if ((await autoSentOn(user.id, sendAt)) >= AUTO_SEND_DAILY_CAP) return { sent: false, why: 'daily cap' };
  const { approveAndSend } = await import('./send');
  const r = await approveAndSend(user, msg.id, msg.bodyDraft, msg.subject, now, { scheduleAt: sendAt });
  if (!r.ok) return { sent: false, why: r.error };
  await db.outbound.update(msg.id, { autoSent: true });
  if (!person.timezone && zone !== user.timezone) await db.people.update(person.id, { timezone: zone });
  return { sent: true, sendAt: sendAt.toISOString() };
}
