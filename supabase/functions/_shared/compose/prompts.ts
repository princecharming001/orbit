/**
 * compose-v2.0 (§7.6): one message the user sends as themselves, on Opus 5.5 at medium effort, with structured
 * output = the ComposedMessage fields the model writes (subject, body, ask, hooks); the server fills the rest. The
 * forwardable-blurb paragraph is appended for `forwardable_blurb`, and the reply paragraph of §8.6 for `reply`.
 * The instruction block comes first and is the cached part; the inputs follow in tagged blocks.
 */
import type { ComposedMessage, GoalKind, MessageKind } from '@orbit/core/types';
import { z } from 'zod/v4';

export const PROMPT_VERSION = 'compose-v2.0';

export const composeSchema = z.object({
  subject: z.string().nullable(),
  body: z.string(),
  ask: z.object({
    kind: z.enum(['call', 'question', 'interest', 'intro', 'none']),
    text: z.string(),
  }),
  hooks: z.array(z.object({ text: z.string(), sourceId: z.string() })),
});
export type ComposeOutput = z.infer<typeof composeSchema>;

export type AskKind = ComposedMessage['ask']['kind'];

/** The default ask per goal family (§7.3 table). */
export const GOAL_ASK: Record<GoalKind, AskKind> = {
  recruiting: 'call',
  advice: 'call',
  fundraising: 'interest',
  sales: 'interest',
  hiring: 'interest',
  cofounder: 'call',
  community: 'question',
  collaboration: 'question',
};

/** The ask a kind carries: none for thanks, blurbs, nurture and re-engage notes; an intro for intro requests. */
export function askKindFor(kind: MessageKind, goal: GoalKind, replyWantsCall = false): AskKind {
  switch (kind) {
    case 'intro_request':
      return 'intro';
    case 'forwardable_blurb':
    case 'thank_you':
    case 'reengage':
    case 'nurture':
    case 'congratulate':
    case 'report_back':
      return 'none';
    case 'reply':
      return replyWantsCall ? 'call' : 'none';
    case 'schedule':
      return 'call';
    default:
      return GOAL_ASK[goal];
  }
}

export interface SystemParams {
  userFirstName: string;
  /** "50–110" or "at most 400 characters" */
  wordRange: string;
  askKind: AskKind;
  kind: MessageKind;
  /** the intermediary and the target, for a forwardable blurb */
  blurb?: { intermediary: string; target: string };
}

/** The §7.6 system prompt, with the §7.6 blurb paragraph or the §8.6 reply paragraph when the kind needs it. */
export function composeSystem(p: SystemParams): string {
  const lines = [
    `You write one message that ${p.userFirstName} will send as themselves. It must sound like them, not like a template or a salesperson.`,
    'Hard rules:',
    `- ${p.wordRange} words; one ask: ${p.askKind}; subject 2–6 words.`,
    '- Use at least one opener from <research> and keep it true; cite its source id in hooks.',
    "- Never claim familiarity, shared history or a mutual connection that isn't in the inputs.",
    '- No flattery adjectives (amazing, incredible, inspiring), no "I hope this finds you well", no "quick question", no em-dashes, no exclamation marks unless the voice card uses them.',
    '- Plain words, short sentences (reading grade ≤ 7).',
    '- Match <voice> for greeting, sign-off, contractions and sentence length. Borrow rhythm from <examples>, never their content.',
  ];
  if (p.kind === 'forwardable_blurb' && p.blurb)
    lines.push(
      '',
      `Write a third-person blurb of at most 90 words that ${p.blurb.intermediary} can forward unchanged to ${p.blurb.target}: who ${p.userFirstName} is, the one reason they want to talk to ${p.blurb.target}, and the small ask. No flattery. Facts only from the inputs.`,
    );
  if (p.kind === 'reply')
    lines.push(
      '',
      'Answer what they said. If they proposed times, accept one that is free (given in <free_slots>) or offer those. Keep it shorter than their message unless they asked questions. If a fact is needed that is not in the inputs, write [ASK USER: …] instead of guessing.',
    );
  return lines.join('\n');
}

/** Untrusted text inside a tagged block: no way to close the block early or open another. */
export function block(tag: string, text: string | undefined | null): string {
  const clean = (text ?? '').replace(/<\/?[a-z_]+[^>]*>/gi, ' ').trim();
  return `<${tag}>${clean ? `\n${clean}\n` : ''}</${tag}>`;
}

export interface UserBlocks {
  task: string;
  userContext: string;
  goal: string;
  recipient: string;
  research: string;
  thread: string;
  via: string;
  voice: string;
  examples: string;
  freeSlots?: string;
}

/** The per-call data, in the §7.6 order. */
export function composeUser(b: UserBlocks): string {
  return [
    block('task', b.task),
    block('user_context', b.userContext),
    block('goal', b.goal),
    block('recipient', b.recipient),
    block('research', b.research),
    block('thread', b.thread),
    block('via', b.via),
    block('voice', b.voice),
    block('examples', b.examples),
    ...(b.freeSlots !== undefined ? [block('free_slots', b.freeSlots)] : []),
  ].join('\n');
}

/** The retry turn (§7.3 step 3): the same inputs plus the issues to fix. */
export function retryNote(issues: string[]): string {
  return `\n<issues>\n${issues.map((i) => `- ${i}`).join('\n')}\n</issues>\nRewrite the message so it passes every rule. Keep what was true and fix only these issues.`;
}

/** `[ASK USER: …]` markers: facts only the user can give (§8.6). A draft with one is never sent. */
export const ASK_USER = /\[ASK USER:\s*([^\]]*)\]/g;

export function askUserMarkers(text: string): string[] {
  return [...text.matchAll(ASK_USER)].map((m) => m[1]!.trim()).filter(Boolean);
}
