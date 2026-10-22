/**
 * The outreach coach's data: the sample message for each kind of outreach in the student's current style, and the
 * messages they actually sent, sorted by kind, with whether each got an answer, whether a follow-up went after it,
 * and (for a follow-up) how long after the message before it.
 */
import type {
  ChatStage,
  CoachMessage,
  CoachSample,
  CoachSampleInput,
  CoachType,
  RecruitingGoals,
  StyleCard,
  User,
  UserSettings,
} from '@orbit/core';
import { coachSample, coachSampleContext, coachTypeOf, generateDraft, wordsIn } from '@orbit/core';
import { db } from '../db/schema';
import { llmDraft, llmEnabled, llmStyleFeedback, toLlmError } from '../integrations/anthropic';
import { asNote, changesFromLlm, interpretFeedback } from './coachTuning';
import { currentStyleCard, type StyleTuningEntry, tuneStyle } from './style';

const DAY = 86_400_000;

/** A chat at one of these stages got an answer (a decline is an answer too). */
const ANSWERED: ReadonlySet<ChatStage> = new Set([
  'replied',
  'scheduling',
  'scheduled',
  'completed',
  'followed_up',
  'nurturing',
  'declined',
]);
const INBOUND_TOUCH = new Set(['email_in', 'linkedin_in', 'text_in', 'meeting']);

/** The student, as the sample message sees them. */
export function coachSampleUser(
  user: User,
  goals: Pick<RecruitingGoals, 'cycleLabel' | 'targetFunctions'> | undefined,
  settings: Pick<UserSettings, 'schedulingLink'> | undefined,
): CoachSampleInput['user'] {
  return {
    firstName: user.firstName,
    lastName: user.lastName,
    fullName: user.fullName,
    school: user.school,
    gradYear: user.graduationYear,
    degree: user.degree,
    majors: user.majors ?? [],
    cycleLabel: goals?.cycleLabel ?? '',
    targetFunctions: goals?.targetFunctions?.length ? goals.targetFunctions : ['product'],
    schedulingLink: settings?.schedulingLink,
    timezone: user.timezone,
  };
}

/** The sample of one kind, written by the real draft engine to Sarah Chen at Notion, in the card's style. */
export async function coachSampleFor(
  user: User,
  type: CoachType,
  card: StyleCard,
  now = new Date(),
): Promise<CoachSample> {
  const [goals, settings] = await Promise.all([db.goals.get(user.id), db.settings.get(user.id)]);
  return coachSample(type, { user: coachSampleUser(user, goals, settings), styleCard: card, now });
}

/**
 * The same sample as Claude writes it from the template (what drafts look like with Claude on: it also follows the
 * length, exclamation marks, emoji and notes on the card). Undefined when Claude is off or declines.
 */
export async function claudeSampleFor(
  user: User,
  type: CoachType,
  card: StyleCard,
  now = new Date(),
): Promise<CoachSample | undefined> {
  const [goals, settings] = await Promise.all([db.goals.get(user.id), db.settings.get(user.id)]);
  const ctx = coachSampleContext(type, {
    user: coachSampleUser(user, goals, settings),
    styleCard: card,
    now,
  });
  const template = generateDraft(ctx);
  const d = await llmDraft(ctx, template);
  if (!d) return undefined;
  const body = (type === 'linkedin_note' ? (d.bodyShort ?? d.body) : d.body).trim();
  return {
    type,
    subject: type === 'cold_email' ? (d.subject ?? template.subject) : undefined,
    body,
    words: wordsIn(body),
    chars: body.length,
  };
}

/**
 * Every message the student sent from Orbit, as the coach reads it. Replied: they wrote back after it (an inbound
 * touchpoint later than it, or a later inbound on the chat), or, for a first message, the chat moved to replied or
 * beyond.
 */
export async function sentForCoach(userId: string, now = new Date()): Promise<CoachMessage[]> {
  const sent = (
    await db.outbound
      .where('userId')
      .equals(userId)
      .filter((o) => o.status === 'sent' && !!o.sentAt)
      .toArray()
  ).sort((a, b) => a.sentAt!.localeCompare(b.sentAt!));
  if (!sent.length) return [];
  const personIds = [...new Set(sent.map((o) => o.personId))];
  const chatIds = [...new Set(sent.map((o) => o.chatId).filter((c): c is string => !!c))];
  const [chats, touches] = await Promise.all([
    db.chats.bulkGet(chatIds),
    db.touchpoints.where('personId').anyOf(personIds).toArray(),
  ]);
  const chatById = new Map(chats.filter((c) => !!c).map((c) => [c!.id, c!]));
  const inboundAt = new Map<string, string[]>();
  for (const t of touches)
    if (t.userId === userId && INBOUND_TOUCH.has(t.kind))
      inboundAt.set(t.personId, [...(inboundAt.get(t.personId) ?? []), t.occurredAt]);
  const out: CoachMessage[] = [];
  for (const [i, o] of sent.entries()) {
    const body = (o.bodyFinal ?? o.bodyDraft ?? '').trim();
    const type = coachTypeOf({ kind: o.kind, channel: o.channel, body, handoffVia: o.handoffVia });
    if (!type || !body) continue;
    const at = o.sentAt!;
    const chat = o.chatId ? chatById.get(o.chatId) : undefined;
    const later = sent.slice(i + 1).filter((x) => x.personId === o.personId);
    const earlier = sent.slice(0, i).filter((x) => x.personId === o.personId);
    const answeredAfter =
      (inboundAt.get(o.personId) ?? []).some((t) => t > at) ||
      (!!chat?.lastInboundAt && chat.lastInboundAt > at);
    const firstTouch = type === 'cold_email' || type === 'linkedin_note' || type === 'linkedin_message';
    const prev = earlier.at(-1);
    out.push({
      id: o.id,
      type,
      subject: o.subject,
      body,
      replied: answeredAfter || (firstTouch && !!chat && ANSWERED.has(chat.stage)),
      followedUp: later.some((x) => x.kind === 'bump'),
      ageDays: (now.getTime() - new Date(at).getTime()) / DAY,
      gapDays:
        type === 'follow_up' && prev?.sentAt
          ? (new Date(at).getTime() - new Date(prev.sentAt).getTime()) / DAY
          : undefined,
    });
  }
  return out;
}

export interface FeedbackResult {
  entries: StyleTuningEntry[];
  /** Claude read the part the rules did not understand */
  usedClaude: boolean;
  /** Claude was asked and failed: the words went into the notes instead */
  claudeError?: string;
}

/**
 * What the student told the coach, applied: rules first, then Claude (when drafting with Claude is on) for whatever
 * the rules did not understand, and the notes every draft reads for anything left.
 */
export async function applyCoachFeedback(
  user: Pick<User, 'id' | 'firstName'>,
  text: string,
  type?: CoachType,
  now = new Date(),
): Promise<FeedbackResult> {
  const said = text.trim();
  if (!said) return { entries: [], usedClaude: false };
  const card = await currentStyleCard(user);
  const reading = interpretFeedback(said, card);
  const entries = (await tuneStyle(user, reading.changes, { by: 'you', said, type }, now)).entries;
  if (!reading.unmatched.length) return { entries, usedClaude: false };
  const rest = reading.unmatched.join('. ');
  let claudeError: string | undefined;
  if (llmEnabled('drafts')) {
    try {
      const r = await llmStyleFeedback(rest, await currentStyleCard(user));
      const changes = r ? changesFromLlm(r) : [];
      if (changes.length) {
        const more = await tuneStyle(user, changes, { by: 'claude', said: rest, type }, now);
        return { entries: [...entries, ...more.entries], usedClaude: true };
      }
    } catch (e) {
      claudeError = toLlmError(e).message;
    }
  }
  const noted = await tuneStyle(
    user,
    [{ kind: 'note', text: asNote(rest) }],
    { by: 'you', said: rest, type },
    now,
  );
  return { entries: [...entries, ...noted.entries], usedClaude: false, claudeError };
}
