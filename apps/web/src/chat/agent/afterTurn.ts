/**
 * What the chat learns after a turn (plan 16 §10.6, §1.6; plan 17 §G). Every pass runs once the reply is done and
 * never holds up or fails the chat: none is awaited by the turn, and any failure is dropped.
 *
 * In this browser (no Orbit account): engine/memoryLearn.ts reads the student's last message (Claude when it is
 * reachable, Orbit's own rules otherwise), keeps what they said about themselves in local memory, adds recruiting
 * targets they stated to their goals, and says so in one short line under the reply.
 *
 * In account mode, on the server:
 *
 * - Memory: a turn whose message is at least 20 characters sends the last two student turns and the replies after
 *   them to /memory/extract, which keeps what is worth remembering (Settings, Memory lists it).
 * - Goals: a turn whose message mentions plans (the §1.6 keywords) sends the last six turns to /goals/infer. The
 *   first proposal that is not already a goal is offered under the reply: "Want me to track this as a goal?" with
 *   tap-to-answer choices (the offer_choices widget). The offer is shown live and not stored, so the history the
 *   model replays is left exactly as it was; instead the proposal goes into the next turn's snapshot, and on "yes"
 *   the model calls set_goal with its kind, targets and the student's words as evidence. The no-key router reads the
 *   Yes choice ("Track a goal: <title>") as set_goal too. An offer lasts for the next turn of its conversation only.
 */
import type { ChatTurn, ProposedGoal, User } from '@orbit/core';
import { newId } from '@orbit/core';
import { activeGoals, GOAL_KIND_LABELS, inferGoalsFromChat } from '../../engine/goals';
import { extractFromChat } from '../../engine/memory';
import { learnedNote, learnFromTurn } from '../../engine/memoryLearn';
import { isServerUser } from '../../integrations/orbitApi';
import type { ChatMessage, TurnEvent } from '../types';
import { kindFrom } from './routerNetwork';
import type { ChatStore } from './store';

/** A message shorter than this holds nothing worth remembering ("thanks", "yes please"). */
export const MEMORY_MIN_CHARS = 20;
/** §1.6: the words that say a student is talking about plans. */
export const PLAN_WORDS =
  /\b(?:rais(?:e|es|ed|ing)|hir(?:e|es|ed|ing)|looking for|apply(?:ing)?|applied|internships?|jobs?|customers?|co-?founders?|collaborat\w*|mentors?|community)\b/i;
export const MAX_TURNS = 6;
export const MAX_CHARS = 8000;
const TURN_CHARS = 2000;
/** an offer nobody answered is dropped after this long */
const OFFER_TTL_MS = 30 * 60_000;

export function mentionsPlans(text: string): boolean {
  return PLAN_WORDS.test(text);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      b && typeof b === 'object' && (b as { type?: string }).type === 'text'
        ? (b as { text: string }).text
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * The conversation as text turns, oldest first: what the student wrote and what Orbit answered. Tool results,
 * snapshots, decisions and error notes are left out; the replies of one tool loop become one turn.
 */
export function textTurns(messages: ChatMessage[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const m of [...messages].sort((a, b) => a.seq - b.seq)) {
    if (m.meta || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = textOf(m.content).trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role && m.role === 'assistant') last.text = `${last.text}\n${text}`;
    else out.push({ role: m.role, text });
  }
  return out;
}

/** The last `users` student turns with the replies after each: at most 6 turns and 8,000 characters in all. */
export function lastTurns(turns: ChatTurn[], users: number): ChatTurn[] {
  const starts = turns.flatMap((t, i) => (t.role === 'user' ? [i] : []));
  if (!starts.length) return [];
  const from = starts[Math.max(0, starts.length - users)]!;
  const picked = turns
    .slice(from)
    .slice(-MAX_TURNS)
    .map((t) => ({
      role: t.role,
      text: t.text.length > TURN_CHARS ? `${t.text.slice(0, TURN_CHARS - 1)}…` : t.text,
    }));
  while (picked.length > 1 && picked.reduce((n, t) => n + t.text.length, 0) > MAX_CHARS) picked.shift();
  return picked;
}

// ---- goal offers ---------------------------------------------------------------------------------------------------

interface GoalOffer {
  conversationId: string;
  /** the last stored message when it was offered: a later one means the student has answered (or moved on) */
  seq: number;
  at: number;
  goal: ProposedGoal;
}

const offers = new Map<string, GoalOffer>();

/** The goal the chat just offered to track, while the student's next turn can still answer it. */
export function offeredGoal(userId: string, now = Date.now()): ProposedGoal | undefined {
  const o = offers.get(userId);
  if (o && now - o.at > OFFER_TTL_MS) {
    offers.delete(userId);
    return undefined;
  }
  return o?.goal;
}

/** The snapshot's line for an open offer, so a "yes" becomes set_goal with what was proposed. */
export function offeredGoalLine(userId: string): string | undefined {
  const g = offeredGoal(userId);
  if (!g) return undefined;
  const targets = Object.fromEntries(Object.entries(g.targets).filter(([, v]) => v.length));
  const goal = {
    kind: g.kind,
    title: g.title,
    ...(Object.keys(targets).length ? { targets } : {}),
    ...(Object.keys(g.criteria).length ? { criteria: g.criteria } : {}),
    ...(g.successMetric ? { successMetric: g.successMetric } : {}),
    ...(g.dueAt ? { dueAt: g.dueAt } : {}),
  };
  return `Goal offered under your last reply ("Want me to track this as a goal?"): ${JSON.stringify(goal)}. If the student says yes, call set_goal with it and evidence ${JSON.stringify(g.quote)}; otherwise drop it.`;
}

/** Tests only. */
export function resetGoalOffersForTests(): void {
  offers.clear();
}

/** The Yes choice: words the no-key router reads as set_goal, with the kind when the title does not say it. */
export function trackMessage(g: ProposedGoal): string {
  const title = g.title.replace(/\s+/g, ' ').trim();
  return `Track a goal: ${title}${kindFrom(title) === g.kind ? '' : ` (${g.kind})`}`.slice(0, 280);
}

// ---- after a turn --------------------------------------------------------------------------------------------------

export interface AfterTurn {
  user: Pick<User, 'id'>;
  conversationId: string;
  store: ChatStore;
  /** the finished turn's event sink: the goal offer is shown under its reply */
  onEvent: (e: TurnEvent) => void;
}

const lastSeq = (messages: ChatMessage[]) => messages.reduce((n, m) => Math.max(n, m.seq), 0);

/** Run the memory and goal passes for the turn that just finished. Resolves when both are done; never rejects. */
export async function learnAfterTurn(o: AfterTurn): Promise<void> {
  try {
    if (o.store.isTemporary(o.conversationId)) return;
    if (!isServerUser(o.user.id)) return await learnHere(o);
    const messages = await o.store.messages(o.conversationId);
    const seq = lastSeq(messages);
    // an offer from an earlier turn of this chat has had its answer
    const open = offers.get(o.user.id);
    if (open && (open.conversationId !== o.conversationId || open.seq < seq)) offers.delete(o.user.id);
    const turns = textTurns(messages);
    const last = [...turns].reverse().find((t) => t.role === 'user');
    if (!last) return;
    await Promise.all([
      last.text.trim().length >= MEMORY_MIN_CHARS
        ? extractFromChat(o.user, lastTurns(turns, 2)).catch(() => undefined)
        : undefined,
      mentionsPlans(last.text)
        ? offerGoal(o, lastTurns(turns, MAX_TURNS), seq).catch(() => undefined)
        : undefined,
    ]);
  } catch {
    // learning is a bonus: the chat goes on without it
  }
}

/** A message shorter than this holds no statement Orbit's rules read ("ok", "thanks"). */
export const LOCAL_MIN_CHARS = 8;

/** This browser: learn from the student's last message and say in one line what was kept. */
async function learnHere(o: AfterTurn): Promise<void> {
  const messages = await o.store.messages(o.conversationId);
  const seq = lastSeq(messages);
  const turns = textTurns(messages);
  const last = [...turns].reverse().find((t) => t.role === 'user');
  if (!last || last.text.trim().length < LOCAL_MIN_CHARS) return;
  // the student's own message, not a tool result or a decision note
  const userSeq = [...messages]
    .sort((a, b) => b.seq - a.seq)
    .find((m) => m.role === 'user' && !m.meta && textOf(m.content).trim())?.seq;
  const learned = await learnFromTurn(o.user, lastTurns(turns, 2), {
    sourceTurn: userSeq !== undefined ? { conversationId: o.conversationId, seq: userSeq } : undefined,
  });
  const note = learnedNote(learned);
  // the student has already said something else: the line belongs to a reply they have moved past
  if (!note || lastSeq(await o.store.messages(o.conversationId)) !== seq) return;
  o.onEvent({ type: 'text', delta: `\n\n${note}` });
}

async function offerGoal(o: AfterTurn, turns: ChatTurn[], seq: number): Promise<void> {
  const proposals = await inferGoalsFromChat(o.user, turns);
  if (!proposals.length) return;
  const have = new Set((await activeGoals(o.user.id)).map((g) => g.title.trim().toLowerCase()));
  const goal = proposals.find((g) => !g.isUpdateOf && !have.has(g.title.trim().toLowerCase()));
  if (!goal) return;
  // the student has already said something else: the moment for this question has passed
  if (lastSeq(await o.store.messages(o.conversationId)) !== seq) return;
  offers.set(o.user.id, { conversationId: o.conversationId, seq, at: Date.now(), goal });
  const toolUseId = newId('run');
  o.onEvent({
    type: 'text',
    delta: `\n\nWant me to track this as a goal? ${GOAL_KIND_LABELS[goal.kind]}: ${goal.title}.`,
  });
  o.onEvent({ type: 'tool_start', toolUseId, toolName: 'offer_choices' });
  o.onEvent({
    type: 'tool_result',
    toolUseId,
    envelope: {
      kind: 'choices',
      data: {
        options: [
          { label: 'Yes, track it', message: trackMessage(goal) },
          { label: 'Not now', message: 'Not now, thanks.' },
        ],
      },
      summary: 'Asked whether to track a goal.',
    },
  });
}
