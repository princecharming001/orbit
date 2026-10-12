import type { ChatStage, CoffeeChat, StageEvent, User } from '@orbit/core';
import { db } from '../db/schema';
import { moveChat, upcomingMeeting } from './move';
import { applyStage } from './stages';

const DAY = 86_400_000;
/** Days without an answer after the student's last message before a chat counts as gone quiet. */
export const QUIET_DAYS = 7;
const WAITING_STAGES: ChatStage[] = ['outreach_sent', 'replied', 'scheduling'];

/** True when the student wrote last, at least a week ago, and the chat is still waiting on the other person. */
export function wentQuiet(chat: CoffeeChat, now = new Date()): boolean {
  if (!WAITING_STAGES.includes(chat.stage) || !chat.lastOutboundAt) return false;
  if (chat.lastInboundAt && chat.lastInboundAt >= chat.lastOutboundAt) return false;
  // moved on since the student last wrote ("They replied", a move on the board): an answer Orbit cannot see came in
  if (chat.stage !== 'outreach_sent' && chat.stageEnteredAt > chat.lastOutboundAt) return false;
  return now.getTime() - new Date(chat.lastOutboundAt).getTime() >= QUIET_DAYS * DAY;
}

export type MoveOutcome =
  /** the stage changed; `needsTime` when it is now Scheduled with no meeting on record ("When is the chat?") */
  | { outcome: 'applied'; from: ChatStage; needsTime: boolean }
  /** already in that stage */
  | { outcome: 'unchanged' }
  /** the chat's meeting is still ahead: marking it done now drafts a thank-you for a chat that has not happened */
  | { outcome: 'meeting_ahead'; meetingAt: string };

/**
 * The student moves a chat, with the guards the board and the person page apply: a chat whose meeting is still
 * ahead is not marked Completed without `force`, and a move to Scheduled says when no meeting is known yet.
 */
export async function moveChatGuarded(
  user: Pick<User, 'id'>,
  chat: CoffeeChat,
  to: ChatStage,
  reason: string,
  opts: { force?: boolean; now?: Date } = {},
): Promise<MoveOutcome> {
  const now = opts.now ?? new Date();
  if (chat.stage === to) return { outcome: 'unchanged' };
  if (to === 'completed' && !opts.force) {
    const ahead = await upcomingMeeting(chat, now);
    if (ahead && new Date(ahead.startAt).getTime() > now.getTime())
      return { outcome: 'meeting_ahead', meetingAt: ahead.startAt };
  }
  const from = chat.stage;
  await moveChat(user, chat, to, reason);
  const needsTime = to === 'scheduled' && !(await upcomingMeeting(chat, now));
  return { outcome: 'applied', from, needsTime };
}

/** The student's last move on a chat (the one Undo takes back). */
export async function lastUserMove(chatId: string): Promise<StageEvent | undefined> {
  const events = await db.stageEvents.where('chatId').equals(chatId).toArray();
  return events
    .filter((e) => e.actor === 'user' && e.status === 'applied' && !!e.fromStage && e.reason !== 'user:undo')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** Put a chat back where it was before the last move (the Undo on the toast). Returns the stage it is in now. */
export async function undoStageMove(chatId: string, from?: ChatStage): Promise<ChatStage | undefined> {
  const chat = await db.chats.get(chatId);
  if (!chat) return undefined;
  const back = from ?? (await lastUserMove(chatId))?.fromStage;
  if (!back || back === chat.stage) return chat.stage;
  await applyStage(chat, back, 'user', 'user:undo');
  return (await db.chats.get(chatId))?.stage;
}
