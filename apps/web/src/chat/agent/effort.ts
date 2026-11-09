/**
 * Auto mode (plan 37 §5): Orbit picks Quick or Smart for each turn, model-free and in microseconds. Quick is Claude at
 * `low` effort for lookups, small talk, taps and short replies; Smart is `medium` (the chat's default) for drafting,
 * advice, judgement calls and anything the no-key router cannot name. When unsure it picks Smart: a wrong Quick costs
 * the student an answer, a wrong Smart costs a few cents.
 *
 * The level travels as a per-message effort change in the conversation (loop.ts), never as a change to the request's
 * own effort, so moving between levels keeps the prompt cache. Such a change only takes hold at the student's next
 * message, so a turn cannot move up halfway through; instead, a turn that ended up drafting makes the next one Smart.
 */
import { parsePick } from '../clarify';
import type { ToolSpec } from '../types';
import type { RouterIntent } from './router';
import { readSocial } from './smallTalk';

export type Effort = 'low' | 'medium';

export interface EffortChoice {
  effort: Effort;
  /** why, in a few words, for the usage record and the tests */
  reason: string;
}

/** Tools whose work is a judgement call: a turn that reaches for one wants Smart, and so does the turn after it. */
export const JUDGEMENT_TOOLS = new Set([
  'create_draft',
  'create_drafts',
  'redraft_with_inputs',
  'update_draft_body',
  'draft_reply',
  'answer_reply',
  'ask_for_intro',
  'ask_friend_for_intro',
  'respond_to_friend_ask',
  'plan_for_posting',
  'set_goal',
  'draft_warmup_comment',
  'pick_prep_questions',
  'lookup_playbook',
  'week_review',
]);

/** Changes that are bookkeeping, not judgement: moving a chat, adding a target, a note, a setting. */
const MECHANICAL = new Set([
  'move_pipeline_stage',
  'undo_stage_move',
  'manage_target_company',
  'delete_target_company',
  'hide_person',
  'update_person',
  'add_person',
  'add_sourced',
  'save_suggested_contacts',
  'manage_suggestion',
  'dismiss_suggestion',
  'manage_recommendation',
  'complete_action_item',
  'mark_warmup_step',
  'remember',
  'forget',
  'forget_voice_note',
  'update_settings',
  'update_limits',
  'set_llm_feature',
  'hold_send',
  'pause_autopilot',
  'pause_outreach',
  'discard_draft',
  'undo_send',
  'show_setup',
  'open_page',
  'offer_choices',
]);

/** Words that ask for thought: advice, a plan, a draft, a judgement. */
const THINK =
  /\b(?:should i|should we|what do you think|what would you|how (?:do|can|should|would) i|help me|advice|why|worth it|strategy|plan for|prep me|prepare|draft|write|rewrite|reword|reply|respond|bump|follow ?up|thank(?:-| )?you note|intro(?:duce|duction)?|cover letter|negotiat\w*|compare|decide|pros and cons|is it (?:weird|ok|okay|rude|normal)|what now|what next|next steps?)\b/i;

/** A reply that only acknowledges or answers yes or no. */
const ACK =
  /^(?:y(?:es|ep|eah|up)?|no(?:pe)?|nah|ok(?:ay)?|k|sure|cool|great|nice|thanks?(?: you)?|thx|ty|got it|sounds good|perfect|done|lol|haha|bye|cheers)[.!?]*$/i;

/** A short question about what is on file ("when is my next chat", "how many replied"), with no ask for thought. */
const LOOKUP_QUESTION =
  /^(?:when(?:'s| is| was| are)|where(?:'s| is)|how many|how much|who(?:'s| is| are)|what(?:'s| is| are) (?:my|on)|which of my|show|list|open)\b/i;

export interface EffortContext {
  /** what the no-key router makes of the message (it reads people, companies and the thread) */
  intent?: RouterIntent;
  registry?: ReadonlyMap<string, ToolSpec>;
  /** the turn before this one reached for a judgement tool */
  afterJudgement?: boolean;
  /** Orbi's last reply ended in a question the student is answering */
  answeringQuestion?: boolean;
}

export function pickEffort(raw: string, ctx: EffortContext = {}): EffortChoice {
  const text = raw.trim();
  // a tap on a question back finishes the ask it interrupted: that ask decides
  const pick = parsePick(text);
  if (pick) return pick.ask ? pickEffort(pick.ask, { ...ctx, answeringQuestion: false }) : low('a pick');
  if (ctx.afterJudgement) return medium('after a draft');
  const words = text.split(/\s+/).filter(Boolean).length;
  if (text.length > 300 || /https?:\/\//i.test(text)) return medium('a long message or a link');
  if (THINK.test(text)) return medium('asks for thought');
  if (ACK.test(text)) return ctx.answeringQuestion ? medium('answers a question') : low('an acknowledgement');
  const intent = ctx.intent;
  if (intent?.kind === 'tool') {
    const spec = ctx.registry?.get(intent.tool);
    if (JUDGEMENT_TOOLS.has(intent.tool)) return medium('a judgement tool');
    if (intent.andThen?.length) return medium('two asks in one');
    if (spec?.kind === 'read') return low('a lookup');
    if (MECHANICAL.has(intent.tool)) return low('a small change');
    return medium('a change');
  }
  // small talk (a greeting, thanks, a laugh) is Quick; a statement about their plans is not small talk
  if (readSocial(text).act && words <= 12)
    return ctx.answeringQuestion ? medium('answers a question') : low('small talk');
  if (LOOKUP_QUESTION.test(text) && words <= 10) return low('a question about their data');
  return medium('the router cannot name it');
}

const low = (reason: string): EffortChoice => ({ effort: 'low', reason });
const medium = (reason: string): EffortChoice => ({ effort: 'medium', reason });
