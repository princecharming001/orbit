import type { ChatStage, MessageKind } from '@orbit/core';
import { findPlaybookSection, mayHoldFacts } from '@orbit/core';
import { isJobBoardLink, linkIn, saysApplying } from '../../integrations/postings';
import type { ChoiceOption, ToolSpec } from '../types';
import { type MatchablePerson, resolvePerson } from './people-match';
import { followUp, resolveReferences } from './routerFollowUp';
import { mentioned, routeEarly, routeMore } from './routerMore';
import { routeNetwork } from './routerNetwork';
import type { ThreadContext } from './routerThread';
import { peopleWaiting } from './setup';
import { answerSocial, isNoise, readSocial, type SmallTalkKit, soundsFrustrated } from './smallTalk';
import { fixTypos } from './typos';

/**
 * The no-key path: a deterministic intent router over the same tool registry. It is a table of patterns, not an
 * understanding of language. It handles the common commands (brief, pipeline by stage, who went quiet, find a
 * person, draft a kind of message to a person, add a note, move a chat, routes to a person or company, LinkedIn
 * import, settings questions) and answers everything else honestly: it says what needs a Claude key and where to add
 * one. It never pretends to have understood.
 */

export type RouterIntent =
  | {
      kind: 'tool';
      tool: string;
      input: Record<string, unknown>;
      lead?: string;
      /** the rest of a message that asked for two things: each runs after this one, read on its own */
      andThen?: string[];
    }
  | { kind: 'text'; text: string; href?: string }
  | { kind: 'refuse'; text: string; href?: string };

export interface RouterContext {
  registry: ReadonlyMap<string, ToolSpec>;
  people: MatchablePerson[];
  /** people the student hid, for "unhide Tom" (never matched by any other phrase) */
  hidden?: MatchablePerson[];
  /** known company names (target companies and organizations), for "routes to <company>" */
  companies: string[];
  /** open cards (the ones in Drafts), so "snooze Priya's card" can name one */
  cards?: { id: string; personId?: string; kind: string }[];
  /** the student's drafts that are not sent yet (draft, failed, handed_off), newest first, with their text */
  drafts?: {
    id: string;
    personId: string;
    status: string;
    kind: string;
    body?: string;
    subject?: string;
    suggestionId?: string;
  }[];
  /** open promises the student made (action items), for "I sent Priya my resume" */
  actionItems?: { id: string; personId?: string; text: string }[];
  /** target companies, for "make Evercore top priority" or "drop Figma" */
  targets?: { id: string; name: string }[];
  /** Discover's recommendations, for "save Priya for later" */
  recs?: { id: string; personId: string; status: string }[];
  /** LinkedIn warm-ups in progress, with the next step's id */
  warmups?: { chatId: string; personId: string; next?: string }[];
  /** possible duplicates waiting for the student's answer */
  merges?: { id: string; personIds: string[] }[];
  /** notes Orbit could not match to anyone */
  unmatchedNotes?: { id: string; title?: string; at: string }[];
  /** the time now (dates like "Thursday at 2pm" are read from it) */
  now?: Date;
  /** the person of the next booked chat, for "prep me for my next chat" */
  nextChat?: { personId: string };
  /** the student's first name, for a warm greeting */
  firstName?: string;
  /** how many people have a message waiting on the student today (default: counted from `cards`) */
  waiting?: number;
  /** what is connected (LinkedIn by export or live, Gmail), when known; the sample student has nothing to set up */
  setup?: { linkedin: boolean; linkedinLive: boolean; google: boolean; demo?: boolean };
  /** the student's active goals (plan 16), for "archive my sales goal" */
  goals?: { id: string; kind: import('@orbit/core').GoalKind; title: string }[];
  /** routes found in this tab (account mode), for "ask Sam to introduce me to Priya" */
  paths?: { id: string; firstHopName: string; targetId?: string }[];
  /** the student is signed in to an Orbit account */
  account?: boolean;
  /** what this conversation just showed (routerThread.ts), for follow-ups like "write to her" or "send it" */
  thread?: ThreadContext;
  /** the mode note's sentence about adding a key, appended to refusals */
  modeNote: string;
  settingsHref: string;
}

/** Stage names as a student says them. The first alias of each is the label used in replies. */
export const STAGE_ALIASES: Record<ChatStage, string[]> = {
  identified: ['to contact', 'identified', 'not contacted', 'to reach out to', 'new'],
  warming: ['warming up', 'warming', 'warm up'],
  outreach_sent: [
    'first message sent',
    'outreach sent',
    'outreach',
    'messaged',
    'reached out',
    'contacted',
    'sent',
  ],
  replied: ['replied', 'responded', 'answered', 'heard back', 'wrote back', 'got back'],
  scheduling: ['scheduling', 'finding a time', 'picking a time'],
  scheduled: ['scheduled', 'booked', 'upcoming', 'on the calendar'],
  completed: ['completed', 'done', 'met', 'had the chat', 'finished', 'spoke'],
  followed_up: ['thanked', 'followed up', 'thank you sent'],
  nurturing: ['staying in touch', 'nurturing', 'in touch', 'keep in touch', 'keeping warm'],
  declined: ['declined', 'said no', 'passed', 'not interested', 'turned me down'],
  no_response: ['no response', 'quiet', 'went quiet', 'ghosted', 'no reply', 'silent', 'never replied'],
  archived: ['archived', 'archive'],
};

/** Message kinds as a student says them. */
export const KIND_ALIASES: Record<MessageKind, string[]> = {
  // the plan-16 kinds are written by the composer, not asked for by name: "first message" stays `outreach` here
  first_touch: [],
  warm_first_touch: [],
  forwardable_blurb: [],
  reengage: [],
  thank_you: ['thank you', 'thank-you', 'thanks', 'thank'],
  bump: ['bump', 'follow up', 'follow-up', 'followup', 'nudge', 'reminder', 'ping'],
  intro_request: ['intro request', 'introduction request', 'request for an intro', 'intro', 'introduction'],
  referral_ask: ['referral ask', 'referral request', 'referral', 'ask for a referral'],
  nurture: ['nurture', 'check in', 'check-in', 'checkin', 'catch up', 'catch-up', 'hello'],
  congratulate: ['congratulate', 'congrats', 'congratulations', 'congratulation'],
  schedule: ['scheduling', 'schedule', 'propose times', 'times'],
  reply: ['reply', 'response', 'answer'],
  report_back: ['report back', 'report-back'],
  outreach: [
    'outreach',
    'first message',
    'cold email',
    'cold message',
    'cold',
    'message',
    'email',
    'note',
    'linkedin note',
  ],
};

const SETTINGS_TOPICS: { re: RegExp; section: string; text: string }[] = [
  {
    re: /\b(claude|anthropic|api key|openai|chatgpt)\b/i,
    section: 'integrations',
    text: 'The Claude key and what Claude may do are under Settings, Integrations.',
  },
  {
    re: /\b(google|gmail|calendar|connect|sync)\b/i,
    section: 'integrations',
    text: 'Google, LinkedIn and the resume are connected under Settings, Integrations.',
  },
  {
    re: /\b(tone|style|voice|sign[- ]?off|greeting|formal|casual)\b/i,
    section: 'style',
    text: 'Your writing style (tone, greeting, sign-off) is under Settings, Writing style.',
  },
  {
    re: /\b(daily (send(ing)?|request|token)? ?(limit|cap)s?|limits?|caps?|cooldown|quiet days?|bumps?|how many (emails|messages))\b/i,
    section: 'limits',
    text: 'Sending limits, cooldowns, quiet days and the daily Claude budget are under Settings, Limits and schedule.',
  },
  {
    re: /\b(export|delete|erase|wipe|privacy|my data|everything)\b/i,
    section: 'privacy',
    text: 'Export everything or delete everything under Settings, Data and privacy.',
  },
  {
    re: /\b(goals?|target (roles?|companies|functions|industries)|cycle)\b/i,
    section: 'goals',
    text: 'Your goals and target companies are under Settings, Goals.',
  },
  {
    re: /\b(profile|school|graduation|major|timezone|time zone|name|email address)\b/i,
    section: 'profile',
    text: 'Your profile (school, year, majors, timezone) is under Settings, Profile.',
  },
];

/** The command list, with the student's own people in the examples (the sample names when there are none). */
export function helpText(
  people: { firstName: string; strength: number; isHuman: boolean; hiddenAt?: string }[],
): string {
  const names = [...people]
    .filter((p) => p.isHuman && !p.hiddenAt && p.firstName)
    .sort((a, b) => b.strength - a.strength)
    .map((p) => p.firstName)
    .filter((n, i, all) => all.indexOf(n) === i);
  const [a, b] = [names[0], names[1] ?? names[0]];
  if (!a)
    return 'Try: "what is on today", "show my pipeline", "add Jordan Lee at Figma", "connect Gmail", "import my LinkedIn connections", "set my tone to direct", or a settings question.';
  return HELP_TEXT.replaceAll('Priya', a).replaceAll('Dan', b!);
}

const HELP_TEXT =
  'Try: "what is on today", "show my pipeline", "who went quiet", "who is Priya", "draft a thank you to Priya", "send my draft to Priya", "follow up with Dan", "note about Priya: she suggested the PM team", "move Dan to scheduling", "who can introduce me to Stripe", "unsent drafts", "show my recommendations", "set my tone to direct", or a settings question.';

const PAGE_WORDS: Record<string, string> = {
  today: 'today',
  'the brief': 'today',
  pipeline: 'pipeline',
  people: 'people',
  contacts: 'people',
  map: 'map',
  'the map': 'map',
  discover: 'discover',
  recommendations: 'discover',
  drafts: 'drafts',
  inbox: 'drafts',
  outbox: 'drafts',
  'add note': 'add_note',
  'notes page': 'add_note',
  'note page': 'add_note',
  settings: 'settings',
  profile: 'settings_profile',
  goals: 'settings_goals',
  integrations: 'settings_integrations',
  'writing style': 'settings_style',
  style: 'settings_style',
  limits: 'settings_limits',
  privacy: 'settings_privacy',
};

const FEATURE_WORDS: Record<string, string> = {
  drafts: 'drafts',
  drafting: 'drafts',
  'email triage': 'emailTriage',
  triage: 'emailTriage',
  notes: 'notes',
  resume: 'resume',
  summaries: 'summaries',
  chat: 'chat',
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function clean(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?.!]+$/, '')
    .replace(/\s*(please|thanks|thank you)$/i, '')
    .replace(/[?.!]+$/, '')
    .trim();
}

/** The utterance as small talk sees it: lower case, straight quotes, no trailing punctuation. */
function text0(raw: string): string {
  return raw
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[?.!,]+$/, '')
    .trim();
}

const CHATTY_PREFIX =
  /^(hey|hi|hello|ok|okay|please|pls|plz|orbit|orbi|can you|could you|would you|will you|can u|could u|would u|will u|i want to|i'd like to|i need to|let's|lets|just|quick question|help me(?= (?:write|draft|find|prep|add|send|follow|reach|get|make|set|move|see)))[,!.:]?\s+/i;

/** "Hey Orbit, can you show my pipeline" -> "show my pipeline". */
function stripChatter(text: string): string {
  let t = text.replace(/^(?:yes|yeah|yep|sure|ok|okay|alright),\s+(?=\w)/i, '');
  for (let i = 0; i < 6 && CHATTY_PREFIX.test(t); i++) t = t.replace(CHATTY_PREFIX, '');
  return t.trim();
}

function stripName(raw: string): string {
  return raw
    .replace(/^(with|to|for|about|on|up with)\s+/i, '')
    .replace(/^(a|an|the|my)\s+/i, '')
    .replace(/^(?:(?:coffee )?chat|call|meeting|chats) with\s+/i, '')
    .replace(/'s$/i, '')
    .replace(/[?.!,]+$/, '')
    .trim();
}

function findStage(text: string): ChatStage | undefined {
  const t = text.toLowerCase();
  let best: { stage: ChatStage; len: number } | undefined;
  for (const [stage, aliases] of Object.entries(STAGE_ALIASES) as [ChatStage, string[]][])
    for (const a of [...aliases, stage.replace('_', ' '), stage])
      if (new RegExp(`(^|\\b)${esc(a)}(\\b|$)`, 'i').test(t) && (!best || a.length > best.len))
        best = { stage, len: a.length };
  return best?.stage;
}

export function findKind(text: string): MessageKind | undefined {
  const t = text.toLowerCase();
  let best: { kind: MessageKind; len: number } | undefined;
  for (const [kind, aliases] of Object.entries(KIND_ALIASES) as [MessageKind, string[]][])
    for (const a of [...aliases, kind.replace('_', ' '), kind])
      if (new RegExp(`(^|\\b)${esc(a)}(\\b|$)`, 'i').test(t) && (!best || a.length > best.len))
        best = { kind, len: a.length };
  return best?.kind;
}

export function stageLabel(stage: ChatStage): string {
  return STAGE_ALIASES[stage][0]!;
}

/** Words that point at someone shown earlier, never a name on their own. */
const REFERENCE =
  /^(?:(?:(?:the|that|this) )?(?:person|contact|card|step|warm-?up|suggestion|new contact|new person)\b.*|(?:the|that|this) (?:one|note|draft|message)\b.*|route \d.*|her|him|them|she|he|they|it|this|that|these|those|me|you|someone|somebody|anyone|everyone|this person|that person|the person|this one|that one|the new contact|the person i just added|(?:the )?(?:top|first|last) (?:\d+|two|three|four|five)|(?:the )?(?:first|second|third|fourth|fifth|last)(?: one)?|all of them|each of them|both(?: of them)?)$/i;

const NOT_NOW =
  /^(not now|maybe later|later|no|nope|no thanks|nah|nah i'?m good|i'?m good|im good|all good|nothing|never ?mind|nvm|not yet|skip|pass)$/;
const YES =
  /^(show me|yes|yeah|yep|yup|sure|ok show me|go ahead|let'?s do it|let'?s go|do it|sounds good show me)$/;
const ADD_SOMEONE =
  /^(add|new|log) (someone|somebody|a person|a contact|a new person)( (i|we) (met|know|talked to|spoke to))?$|^(i )?(met|know) (someone|somebody)( new)?$/;

/** Patterns that only a model could serve: say so instead of guessing. */
const NEEDS_MODEL =
  /\b(change the (?:first|second|third|last|opening|closing) (?:sentence|line|paragraph)|why|should i(?! (follow up|bump|nudge))|what do you think|do you think|rewrite|reword|shorter|longer|summari[sz]e|explain|compare|which (one|of)|best|recommend|advice|advise|strategy|plan for|help me (decide|think|write|figure)|what would you|how should|is it (ok|okay|fine|rude|too)|improve|polish|translate|make (it|this)|tips?)\b/i;

/**
 * Read one message. Example names in the replies ("like: write to {name}") are the student's own people, so an
 * example never names someone they do not know.
 */
export function routeUtterance(raw: string, ctx: RouterContext): RouterIntent {
  const intent = routeInner(raw, ctx);
  const fill = (t: string) => fillExamples(t, ctx);
  if (intent.kind === 'tool') return intent.lead ? { ...intent, lead: fill(intent.lead) } : intent;
  return { ...intent, text: fill(intent.text) };
}

/** "{name}", "{name2}" and "{company}" in a reply, as the student's closest people and first target company. */
export function fillExamples(text: string, ctx: Pick<RouterContext, 'people' | 'companies'>): string {
  if (!text.includes('{')) return text;
  const names = [...ctx.people]
    .filter((p) => p.isHuman && !p.hiddenAt && p.firstName)
    .sort((a, b) => b.strength - a.strength)
    .map((p) => p.firstName)
    .filter((n, i, all) => all.indexOf(n) === i);
  return text
    .replaceAll('{name}', names[0] ?? 'Lena')
    .replaceAll('{name2}', names[1] ?? names[0] ?? 'Dan')
    .replaceAll('{company}', ctx.companies[0] ?? 'Stripe');
}

function routeInner(raw: string, ctx: RouterContext): RouterIntent {
  // small talk is read on the whole message first; a greeting in front of an ask ("yo show my pipeline") drops off
  const social = readSocial(raw);
  if (social.rest) raw = social.rest;
  let text = stripChatter(clean(raw));
  let lower = text.toLowerCase();
  // a slipped letter in a command word ("piepline") is put right; names and companies stay as typed
  {
    const keep = new Set<string>();
    const words = (s: string) =>
      s
        .toLowerCase()
        .split(/[^a-z']+/)
        .filter(Boolean);
    for (const p of ctx.people)
      for (const w of words(`${p.displayName} ${p.currentOrganizationRaw ?? ''}`)) keep.add(w);
    for (const c of ctx.companies) for (const w of words(c)) keep.add(w);
    const fixed = fixTypos(text, keep);
    if (fixed !== text) {
      text = fixed;
      lower = text.toLowerCase();
    }
  }
  const has = (tool: string) => ctx.registry.has(tool);

  // one short line on what unlocks it, not the whole mode note (that sits under the composer already)
  const keyLine = /turned off/i.test(ctx.modeNote)
    ? 'Turn on chat with Claude in Settings, Integrations for that.'
    : /limit|used all|unavailable|until tomorrow/i.test(ctx.modeNote)
      ? 'Claude is paused right now, so that has to wait.'
      : 'Add a Claude key in Settings, Integrations for that.';
  const refuse = (why: string): RouterIntent => ({
    kind: 'refuse',
    text: `${why} ${keyLine}`,
    href: ctx.settingsHref,
  });
  const HELP = helpText(ctx.people);
  const missing = (what: string): RouterIntent => ({
    kind: 'refuse',
    text: `I can't ${what} from the chat yet. ${HELP}`,
  });
  const viaTool = (
    tool: string,
    input: Record<string, unknown>,
    lead?: string,
    what?: string,
  ): RouterIntent => {
    const spec = ctx.registry.get(tool);
    if (!spec) return missing(what ?? `do that`);
    // strict: an input the tool would silently strip means the router's table is out of step with the tool
    const parsed = spec.input.strict().safeParse(input);
    if (!parsed.success)
      return {
        kind: 'refuse',
        text: `Orbit's command list is out of step with its ${tool.replace(/_/g, ' ')} tool, so this cannot run right now. ${HELP}`,
      };
    return { kind: 'tool', tool, input: parsed.data as Record<string, unknown>, lead };
  };
  // plan 23 §4.1: a job link, or "I'm applying to Stripe", is the plan for that posting
  {
    // read from what was typed: the cleanup below the greeting never touches a link
    const link = linkIn(raw);
    const scheduling = /\b(calendly|cal\.com|scheduling|booking|book a time|my link)\b/i.test(raw);
    const drafting = /\b(re-?draft|draft|message|email|write|reply|note)\b/i.test(raw);
    if (
      link &&
      !scheduling &&
      (isJobBoardLink(link) || /\b(job|posting|role|position|opening|apply|applying)\b/i.test(lower)) &&
      has('plan_for_posting')
    )
      return viaTool('plan_for_posting', { url: link }, undefined, 'plan for a posting');
    const way = /\bplan my way in(?:to)?\s+(?:the\s+)?(.+)$/i.exec(raw.trim());
    if (way && has('plan_for_posting'))
      return viaTool(
        'plan_for_posting',
        { text: way[1]!.replace(/[.?!]+$/, '').replace(/\s+role\b/i, '') },
        undefined,
        'plan for a posting',
      );
    if (saysApplying(raw) && !drafting && has('plan_for_posting')) {
      const what = raw
        .replace(/^.*?\b(?:applying|apply)\s+(?:to|at|for)\s+/i, '')
        .replace(/[.?!]+$/, '')
        .trim();
      if (what) return viaTool('plan_for_posting', { text: what }, undefined, 'plan for a posting');
    }
    // plan 23 §4.9: what Orbit sends on its own lives in Settings, Limits
    if (
      (/\b(bumps?|thank-?yous?|scheduling repl(?:y|ies))\b/i.test(lower) &&
        /\b(on (your|its) own|by (yourself|itself)|for me)\b/i.test(lower) &&
        /\bsend/i.test(lower)) ||
      /\bwhat (can|does|will) orbit send (by|on) (itself|its own)\b/i.test(lower)
    )
      if (has('get_settings'))
        return viaTool('get_settings', { section: 'limits' }, undefined, 'read your settings');
    // plan 23 §4.4: the week's chats
    if (
      /\b(upcoming|next|this week'?s?|today'?s?)\s+(coffee\s+)?chats\b|\bmy coffee chats\b|\bwho am i (meeting|talking to)\b|\bchats? (coming up|this week|today)\b|\b(did|have) the notes from my (chat|call|meeting)\b/i.test(
        lower,
      ) &&
      has('list_upcoming_chats')
    )
      return viaTool('list_upcoming_chats', {}, undefined, 'list your chats');
    // plan 23 §4.8: the week in review
    if (
      /\bhow (did|was) my week\b|\b(weekly|week'?s?) (review|recap)\b|\bwhat moved this week\b/i.test(
        lower,
      ) &&
      has('week_review')
    )
      return viaTool('week_review', {}, undefined, 'review your week');
  }
  // "her", "them" or "the top 3" are never a name (a prefix match would find "Herrera"): with nothing shown before,
  // they mean nobody yet, and the reply asks who
  const person = (name: string): { person?: MatchablePerson; candidates: MatchablePerson[] } => {
    const n = stripName(name);
    if (REFERENCE.test(n)) return { candidates: [] };
    const r = resolvePerson(ctx.people, n);
    if (r.person || r.candidates.length) return r;
    // "Tomas for the chat", "Priya, wrong role", "Priya's stage", "Lena directly": the name, without what follows it
    const cuts = [
      /^(.+?)\s*,/,
      /^(.+?)\s+(?:for|about|after|from|on|at|re|regarding|to say|and|with|before|since|because|this|next|tomorrow|today|back)\b/i,
      /^(.+?)(?:'s)?\s+(?:follow-?up|thank-?you|check-?in|card|chat|call|draft|message|email|note|stage|post|dot|page|profile|linkedin|summary|score|research|deadline|directly|myself|now|first|again|instead|anyway|please|too)\b/i,
    ];
    for (const re of cuts) {
      const cut = n.match(re);
      if (!cut) continue;
      const hit = resolvePerson(ctx.people, stripName(cut[1]!));
      if (hit.person || hit.candidates.length) return hit;
    }
    return r;
  };
  const nobody = (name: string): RouterIntent =>
    REFERENCE.test(stripName(name))
      ? {
          kind: 'text',
          text: /top|first|second|third|last|all|each|both/i.test(name)
            ? 'Which people? Show a list first, like: who do I know at {company}, or who went quiet.'
            : 'Who do you mean? Say their name, like: write to {name}.',
        }
      : {
          kind: 'text',
          text: `I could not find anyone called "${stripName(name)}" in your people. Check the spelling, or add them from the People page.`,
          href: '/people?view=list',
        };
  const ambiguous = (name: string, candidates: MatchablePerson[]): RouterIntent =>
    has('search_people')
      ? viaTool('search_people', { query: stripName(name) }, 'More than one person matches. Pick one:')
      : {
          kind: 'text',
          text: `More than one person matches "${stripName(name)}": ${candidates.map((p) => p.displayName).join(', ')}. Say the full name.`,
        };

  // ---- what the conversation just showed: follow-ups ("send it", "and Dan?") and references ("her", "the top 3") ----
  if (ctx.thread) {
    const thread = ctx.thread;
    const f = followUp(text, thread, {
      viaTool,
      person,
      nobody,
      ambiguous,
      findKind,
      cards: ctx.cards ?? [],
      reroute: (message) =>
        routeUtterance(message, {
          ...ctx,
          thread: { ...thread, steps: undefined, choices: undefined, pending: undefined },
        }),
    });
    if (f) return f;
    const resolved = resolveReferences(text, thread);
    if (resolved !== text) {
      text = resolved;
      lower = text.toLowerCase();
    }
  }

  // ---- small talk: short, warm, one next step. A tap-to-answer reply when the tool exists, plain words when not. ----
  const name = ctx.firstName?.trim();
  const humans = ctx.people.filter((p) => !p.hiddenAt).length;
  const empty = humans === 0;
  const waiting = ctx.waiting ?? peopleWaiting(ctx.cards ?? []);
  const unsent = (ctx.drafts ?? []).filter((d) => d.status === 'draft').length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  /** Text first, then the tool's widget under it. Falls back to plain words when the tool is not in the registry. */
  const withTool = (
    tool: 'offer_choices' | 'show_setup',
    input: Record<string, unknown>,
    lead: string,
    fallback: string,
  ): RouterIntent => {
    const spec = ctx.registry.get(tool);
    const parsed = spec?.input.safeParse(input);
    if (parsed?.success) return { kind: 'tool', tool, input: parsed.data as Record<string, unknown>, lead };
    return { kind: 'text', text: fallback };
  };
  const choose = (statement: string, question: string, options: ChoiceOption[]): RouterIntent => {
    // without the tool, the useful sentence stays and the first pill becomes words to type
    const kept = question.replace(/\s*[^.?]*\?$/, '').trim();
    return withTool(
      'offer_choices',
      { options },
      [statement, question].filter(Boolean).join(' '),
      [statement, kept, `Say "${options[0]!.message}" and I'll take it from there.`]
        .filter(Boolean)
        .join(' '),
    );
  };
  const setupLinkedin = (statement: string): RouterIntent =>
    withTool(
      'show_setup',
      { what: 'linkedin' },
      statement,
      `${statement} Use the + button and choose Import LinkedIn connections.`,
    );
  /** The one most useful thing to do right now, as a sentence, a question and its answers. */
  const bestMove = () => {
    if (waiting > 0) {
      // one person waiting, and the card says who: their name, the way a friend would say it
      const ids = [...new Set((ctx.cards ?? []).map((c) => c.personId).filter(Boolean))];
      const one = waiting === 1 && ids.length === 1 ? ctx.people.find((p) => p.id === ids[0]) : undefined;
      return {
        statement: one?.firstName
          ? `${one.firstName} is waiting to hear from you.`
          : waiting === 1
            ? 'Someone is waiting to hear from you.'
            : `${waiting} people are waiting to hear from you.`,
        question: 'Want to start there?',
        options: [
          { label: 'Show me', message: "What's on today?" },
          { label: 'Not now', message: 'Not now' },
        ],
      };
    }
    if (unsent > 0)
      return {
        statement: `You've got ${plural(unsent, 'draft', 'drafts')} ready to look at.`,
        question: 'Want to start there?',
        options: [
          { label: 'Show me', message: 'Show my drafts' },
          { label: 'Not now', message: 'Not now' },
        ],
      };
    return {
      statement: "Nothing's waiting on you today.",
      question: 'Want to see where your chats stand?',
      options: [
        { label: 'Show me', message: 'Show my pipeline' },
        { label: 'Not now', message: 'Not now' },
      ],
    };
  };
  const setupGmail = (statement: string): RouterIntent =>
    withTool(
      'show_setup',
      { what: 'google' },
      statement,
      `${statement} Connect Google under Settings, Integrations.`,
    );
  const setupWidget = (
    what: 'google' | 'linkedin' | 'claude_key' | 'resume',
    statement: string,
  ): RouterIntent =>
    withTool('show_setup', { what }, statement, `${statement} Use the + button, or Settings, Integrations.`);
  const EMPTY_START =
    "Easiest first step is your LinkedIn connections. Drop the export here when you're ready.";
  const GMAIL_NEXT = 'Next easy step is Gmail, so I can see who you email and send what you approve.';
  // an empty account starts with LinkedIn; once LinkedIn is in and there is still nobody, Gmail comes next
  const emptyNext = (lead: string): RouterIntent =>
    ctx.setup?.linkedin && !ctx.setup.google && !ctx.setup.demo
      ? setupGmail(`${lead} ${GMAIL_NEXT}`)
      : setupLinkedin(`${lead} ${EMPTY_START}`);
  const casual = text0(raw);
  const closest = [...ctx.people]
    .filter((p) => p.isHuman && !p.hiddenAt && p.firstName)
    .sort((x, y) => y.strength - x.strength);
  const move = bestMove();
  const kit: SmallTalkKit = {
    firstName: name,
    empty,
    nudge: move,
    idle: waiting === 0 && unsent === 0,
    nudged:
      !!ctx.thread?.choices?.length &&
      move.options.every((o) => ctx.thread!.choices!.some((c) => c.message === o.message)),
    topName: closest[0]?.firstName,
    names: [...(name ? [name] : []), ...ctx.people.map((p) => p.firstName).filter((n): n is string => !!n)],
    now: ctx.now ?? new Date(),
    choose,
    offer: (lead, options, fallback) => withTool('offer_choices', { options }, lead, fallback),
    emptyNext,
  };
  {
    const r = answerSocial(social, kit);
    if (r) return r;
  }
  if (NOT_NOW.test(casual)) {
    const r = answerSocial({ act: 'notnow', casual: social.casual, said: casual }, kit);
    if (r) return r;
  }
  if (YES.test(casual)) {
    if (empty) return setupLinkedin("Great. Let's bring in your LinkedIn connections.");
    if (waiting > 0) return viaTool('get_today_brief', {}, undefined, 'show the brief');
    if (unsent > 0) return viaTool('list_drafts', { list: 'to_send' }, undefined, 'list drafts');
    return viaTool('list_pipeline', {}, undefined, 'list the pipeline');
  }
  if (ADD_SOMEONE.test(casual))
    return {
      kind: 'text',
      text: 'Nice. Who did you meet? Give me their name and where they work, like: add Jordan Lee at Figma.',
    };

  if (!text) return { kind: 'text', text: HELP };

  // help
  if (/^(commands?|options|menu|list of commands)$/i.test(lower)) return { kind: 'text', text: HELP };

  // two asks in one message ("show my pipeline and draft a follow up to Marcus"): the first runs now, the rest after
  {
    const parts = splitAsks(text);
    if (parts.length > 1) {
      const intents = parts.map((p) => routeUtterance(p, { ...ctx, thread: undefined }));
      const first = intents[0]!;
      if (first.kind === 'tool' && intents.slice(1).some((i) => i.kind === 'tool'))
        return { ...first, andThen: parts.slice(1).filter((_, k) => intents[k + 1]!.kind === 'tool') };
    }
  }

  // today's brief
  if (
    /^(today|brief|my brief|my day|agenda|who should i (message|write to|reach out to|contact|email|follow up with|talk to)( today| first| next)?|who'?s next|what'?s? (on|up|new|next)( today| for today)?|what (is|should i do|do i do|do i have)( on| today| for today| now)*|show (me )?(today|my day|the brief)|start my day|plan for today|to ?do)$/i.test(
      lower,
    )
  )
    return viaTool('get_today_brief', {}, undefined, 'show the brief');

  // what a stage means (before the judgement check: "explain" is otherwise a model word)
  {
    const m = lower.match(
      /^(?:what (?:are|is) (?:the |my )?(?:pipeline )?stages|explain (?:the )?(?:pipeline )?stages?(?: (.+))?|what does (.+?) mean|what is the (.+?) stage|what'?s the (.+?) stage)$/,
    );
    if (m) {
      const named = m[1] ?? m[2] ?? m[3] ?? m[4];
      const stage = named ? findStage(named) : undefined;
      if (!named || stage)
        return viaTool('explain_stage', stage ? { stage } : {}, undefined, 'explain the stages');
    }
  }

  // Discover: people worth meeting (before the judgement check: "who should I meet" is a list, not advice)
  if (
    /^(?:show |list |see |open )?(?:me )?(?:my |the )?(?:recommendations|recommended people|suggested people|discover|people (?:i should|to) meet|who should i meet|who should i (?:talk|reach|write) to( next)?|new people to meet)$/i.test(
      lower,
    )
  )
    return viaTool('list_recommendations', {}, undefined, 'list recommendations');

  // the networking agent: goals, scores, research, finding people, intros, replies, autonomy, memory, cadence
  {
    const r = routeNetwork(text, lower, {
      viaTool,
      person,
      nobody,
      ambiguous,
      goals: ctx.goals ?? [],
      paths: ctx.paths ?? [],
      account: !!ctx.account,
    });
    if (r) return r;
  }

  // requests that sound like judgement calls but are not ("what should I send Omar next", "make my drafts formal")
  const more = {
    viaTool,
    person,
    nobody,
    ambiguous,
    findKind,
    findStage,
    choose,
    setupGmail,
    setupLinkedin,
    setup: setupWidget,
  };
  {
    const r = routeEarly(text, lower, ctx, more);
    if (r) return r;
  }

  // free-form questions and judgement calls need the model: say so before any pattern could half-match them
  if (NEEDS_MODEL.test(lower) && !/^(who is|who's|show|open|find|look ?up|tell me about)\b/i.test(lower)) {
    // a judgement call about someone: say so, then offer what Orbit can do for that person
    const about = mentioned(text, ctx.people);
    if (about.person && has('offer_choices')) {
      const p = about.person;
      const first = p.firstName || p.displayName;
      return withTool(
        'offer_choices',
        {
          options: [
            { label: `Write to ${first}`, message: `Write to ${p.displayName}` },
            { label: `Open ${first}`, message: `Who is ${p.displayName}` },
          ],
        },
        `That needs a Claude key to weigh up. Here is what I can do with ${first} now:`,
        `That needs a Claude key: I can't think this one through on my own. ${keyLine}`,
      );
    }
    return refuse("That needs a Claude key: I can't think this one through on my own.");
  }

  // prep for a chat with someone
  {
    const m = text.match(
      /^(?:prep(?:are)?(?: me)?(?: for)?(?: my)?(?: (?:coffee )?chat| call| meeting)?(?: with)?|get me ready for(?: my)?(?: chat| call)?(?: with)?|prep notes for)\s+(?!.*\b(?:message|draft|email|reply|check-?in|follow-?up|thank-?you|note)\b)(.+)$/i,
    );
    if (
      m &&
      /^(?:my )?(?:next|upcoming|tomorrow'?s?|today'?s?)?(?: coffee)?(?: chat| call| meeting)?(?: (?:tomorrow|today|this week|later today|coming up))?$/i.test(
        m[1]!.trim(),
      ) &&
      /\S/.test(m[1]!)
    ) {
      if (ctx.nextChat)
        return viaTool(
          'get_person',
          { personId: ctx.nextChat.personId, include: ['prep', 'facts'] },
          undefined,
          'prep for a chat',
        );
      return viaTool(
        'list_pipeline',
        { stage: 'scheduled' },
        'No chat is booked yet, so there is nothing to prep. These are the chats already scheduled.',
        'list scheduled chats',
      );
    }
    if (m) {
      const r = person(m[1]!);
      if (r.person)
        return viaTool(
          'get_person',
          { personId: r.person.id, include: ['prep', 'facts'] },
          undefined,
          'prep for a chat',
        );
      if (r.candidates.length) return ambiguous(m[1]!, r.candidates);
      return nobody(m[1]!);
    }
  }

  // what Orbit knows about someone, and who they know
  {
    const facts = text.match(
      /^(?:what do (?:i|we) know about|what does orbit know about|facts (?:about|on|for)|notes on|what did (?:i|we) learn from|remind me about)\s+(?!(?:this|that|it)\b)(.+)$/i,
    );
    const knows = text.match(/^(?:who does|who do(?:es)?)\s+(?!(?:i|we|you)\s+know$)(.+?)\s+know$/i);
    const m = facts ?? knows;
    if (m) {
      const r = person(m[1]!);
      if (r.person)
        return viaTool(
          'get_person',
          { personId: r.person.id, include: knows ? ['connections'] : ['facts', 'notes'] },
          undefined,
          'look up a person',
        );
      if (r.candidates.length) return ambiguous(m[1]!, r.candidates);
      return nobody(m[1]!);
    }
  }

  // the notes on record
  {
    const m = text.match(
      /^(?:show |list |see |open )?(?:me )?(?:my |all |all my |the )?(?:meeting )?notes(?: (?:about|for|on|with|from) (.+))?$/i,
    );
    if (m) {
      if (!m[1]) return viaTool('list_notes', {}, undefined, 'list notes');
      const r = person(m[1]);
      if (r.person) return viaTool('list_notes', { personId: r.person.id }, undefined, 'list notes');
      if (r.candidates.length) return ambiguous(m[1], r.candidates);
      return nobody(m[1]);
    }
  }

  // introductions on record
  {
    const m = lower.match(
      /^(?:who introduced me to (.+)|(?:show |list )?(?:my )?(?:introductions|intro chains|introduction chains|referrals)(?: (?:to|for|at|around) (.+))?)$/i,
    );
    if (m) {
      const q = (m[1] ?? m[2])?.trim();
      return viaTool('get_intro_web', q ? { query: stripName(q) } : {}, undefined, 'list introductions');
    }
  }

  // the Claude budget
  if (
    /\b(claude usage|how many (claude |ai )?(requests|tokens)|usage today|my usage|api usage|daily budget|budget left)\b/i.test(
      lower,
    )
  )
    return viaTool('get_usage', {}, undefined, 'show the Claude usage');

  // rebuild the brief
  if (/^(?:refresh|rebuild|update|redo|regenerate)(?: my| the)? (?:brief|today|day|cards)$/i.test(lower))
    return viaTool('refresh_brief', {}, undefined, 'refresh the brief');

  // the account: each of these asks for approval in the card first
  if (
    /^(?:load|try|open|start|show me)(?: the)? (?:demo|sample student|sample data)$|^reset(?: everything)? to(?: the)? demo( data)?$/i.test(
      lower,
    )
  )
    return viaTool('load_demo', {}, undefined, 'load the demo');
  if (
    /^(?:set up orbit for me|leave the demo|exit the demo|clear the demo|start my own(?: setup)?)$/i.test(
      lower,
    )
  )
    return viaTool('leave_demo', {}, undefined, 'leave the demo');
  if (/^(?:export|download|back ?up)(?: all)?(?: of)? (?:my )?(?:data|everything)$/i.test(lower))
    return viaTool('export_data', {}, undefined, 'export your data');
  if (
    /^(?:delete|erase|wipe|remove)(?: all)?(?: of)? (?:my )?(?:data|everything)(?: from orbit| in orbit)?$/i.test(
      lower,
    )
  )
    return viaTool('delete_all_data', {}, undefined, 'delete your data');
  if (/^(?:disconnect|unlink|remove)(?: my)? (?:google|gmail)(?: account)?$/i.test(lower))
    return viaTool('disconnect_google', {}, undefined, 'disconnect Google');

  // connecting Gmail or LinkedIn shows the widget that does it, never a list of steps
  if (
    /^(?:how (?:do|can) i )?(?:connect|link|hook up|set up|sign in to|sign into|add)(?: my)? (?:gmail|google|email|e-?mail|mail|inbox|calendar|google calendar|gmail and calendar|email and calendar)(?: account| too)?$/i.test(
      lower,
    )
  )
    return setupGmail(
      "Here's Gmail and Calendar. Once it's connected I can see who you email and send what you approve.",
    );
  if (/^(?:sync|refresh|check)(?: my)? (?:google|gmail|email|mail|inbox|calendar)$/i.test(lower))
    return setupGmail(
      ctx.setup?.google
        ? 'Reconnect below and I will pull your new mail and meetings.'
        : "Gmail isn't connected yet. Connect it below and I'll keep your inbox in sync.",
    );
  if (
    /^(?:disconnect|unlink|remove)(?: my)? linkedin(?: account| sync)?$|^stop syncing(?: my)? linkedin$/i.test(
      lower,
    )
  )
    return viaTool('disconnect_linkedin', {}, undefined, 'disconnect LinkedIn');
  if (
    /^(?:sync|re-?sync|refresh|update|pull)(?: my)?(?: latest)? linkedin(?: connections| contacts)?(?: again| now)?$|^(?:pull|get|bring in) my (?:latest|new) linkedin connections$/i.test(
      lower,
    )
  )
    return ctx.setup && !ctx.setup.linkedinLive
      ? setupLinkedin("LinkedIn isn't connected live yet. Connect it here and it stays in sync.")
      : viaTool('sync_linkedin', {}, undefined, 'sync LinkedIn');
  if (
    /^(?:how (?:do|can) i )?(?:connect|link|hook up|set up|sign in to|sign into)(?: my)? linkedin(?: account| connections)?$|^keep my linkedin(?: connections)? in sync$/i.test(
      lower,
    )
  )
    return setupLinkedin("Here's LinkedIn. Connect it and I'll bring your connections in.");

  // who the student knows who knows someone (mutual connections), or anyone at a company
  {
    const m = text.match(
      /^(?:who knows|who (?:else )?do (?:i|we) know (?:who|that) knows|(?:show |find |any |list )?(?:my |our )?mutual(?: connections?| friends)?(?: with| for| to| of)|mutuals (?:with|for)|who are (?:my|our) mutuals with)\s+(.+)$/i,
    );
    if (m) {
      const target = stripName(m[1]!);
      const at = target.match(/^(?:someone|anyone|somebody|people) (?:at|in|from) (.+)$/i);
      if (at) {
        const name = stripName(at[1]!);
        const company = ctx.companies.find((c) => c.toLowerCase() === name.toLowerCase()) ?? name;
        return viaTool('find_routes', { company }, undefined, 'find routes to a company');
      }
      const r = person(target);
      if (r.person)
        return viaTool(
          'get_mutual_connections',
          { personId: r.person.id },
          undefined,
          'find mutual connections',
        );
      if (r.candidates.length) return ambiguous(target, r.candidates);
      const company = ctx.companies.find((c) => c.toLowerCase() === target.toLowerCase());
      if (company) return viaTool('find_routes', { company }, undefined, 'find routes to a company');
      return nobody(target);
    }
  }

  // the writing tone
  {
    const m = lower.match(
      /^(?:set|change|switch|make)(?: my)? (?:writing )?(?:tone|style|voice)(?: to| as)? (warm|direct|formal)$/,
    );
    if (m)
      return viaTool(
        'update_settings',
        { section: 'style', tonePreset: m[1] },
        undefined,
        'change your tone',
      );
  }

  // what Claude may do
  {
    const m = lower.match(
      /^(?:turn|switch) (on|off) (?:claude )?(drafts|drafting|email triage|triage|notes|resume|summaries|chat)(?: for claude| with claude)?$/,
    );
    if (m)
      return viaTool(
        'set_llm_feature',
        { feature: FEATURE_WORDS[m[2]!], on: m[1] === 'on' },
        undefined,
        'change what Claude may do',
      );
  }

  // sending limits
  {
    const m = lower.match(
      /^(?:set|change|make)(?: my)? (weekly (?:outreach )?(?:target|goal)|max(?:imum)? bumps|daily (?:gmail|email) (?:cap|limit)|daily linkedin (?:cap|limit)|cooldown(?: hours)?)(?: to| at)? (\d{1,3})$/,
    );
    if (m) {
      const what = m[1]!;
      const n = Number(m[2]);
      const key = what.startsWith('weekly')
        ? 'weeklyOutreachTarget'
        : what.startsWith('max')
          ? 'maxBumps'
          : what.includes('linkedin')
            ? 'dailySendCapLinkedin'
            : what.startsWith('daily')
              ? 'dailySendCapGmail'
              : 'perPersonCooldownHours';
      return viaTool('update_limits', { [key]: n }, undefined, 'change a limit');
    }
  }

  // target companies
  {
    const m = text.match(
      /^(?:add|put)\s+(.+?)\s+(?:to|on|as)\s+(?:my\s+)?(?:target companies|target company|targets|target list|a target|target)$/i,
    );
    if (m)
      return viaTool(
        'manage_target_company',
        { action: 'add', names: m[1]!.trim() },
        undefined,
        'add a target company',
      );
  }

  // go to a page
  {
    const m = lower.match(
      /^(?:go to|take me to|open|navigate to|bring up)(?: the| my)? (.+?)(?: page| tab)?$/,
    );
    const page = m ? PAGE_WORDS[m[1]!] : undefined;
    if (page && page !== 'pipeline' && page !== 'drafts' && page !== 'today')
      return viaTool('open_page', { page }, undefined, 'open a page');
  }

  // hide someone from the lists
  {
    // not the chat's own reasoning ("hide the grey text"), which routerMore reads
    const m = text.match(
      /^(?:hide|mute)\s+(?!(?:the |your |orbit'?s )?(?:grey|gray|reasoning|thinking|thought))(.+?)(?:\s+from (?:my )?(?:lists|people|everything))?$/i,
    );
    if (m) {
      const r = person(m[1]!);
      if (r.person) return viaTool('hide_person', { personId: r.person.id }, undefined, 'hide a person');
      if (r.candidates.length) return ambiguous(m[1]!, r.candidates);
      return nobody(m[1]!);
    }
  }

  // undo the last stage move
  {
    const m = text.match(
      /^undo(?: (?:the|my))?(?: last)?(?: (?:move|stage change|stage move))?(?: (?:for|of|on|with) (.+))?$/i,
    );
    if (m) {
      if (!m[1])
        return {
          kind: 'text',
          text: 'Say whose move to undo, like: undo the move for {name}.',
          href: '/people?view=board',
        };
      const r = person(m[1]);
      if (r.person) return viaTool('undo_stage_move', { personId: r.person.id }, undefined, 'undo a move');
      if (r.candidates.length) return ambiguous(m[1], r.candidates);
      return nobody(m[1]);
    }
  }

  // a card in Drafts: snooze or dismiss it
  {
    const m = text.match(
      /^(snooze|dismiss|skip|remove|hide)(?: the)?(?: card| suggestion)?(?: (?:for|about|on))?\s+(.+?)(?:'s)?(?: card| suggestion)?(?: for (a day|a week|\d+ days?|tomorrow))?$/i,
    );
    const who = m ? person(m[2]!) : undefined;
    if (
      m &&
      /^(snooze|dismiss|skip)$/i.test(m[1]!) &&
      !REFERENCE.test(stripName(m[2]!)) &&
      (who?.person || who?.candidates.length) &&
      !/\b(wrong role|wrong company|discover|recommendation)\b/i.test(text)
    ) {
      const r = person(m[2]!);
      if (r.person) {
        const card = ctx.cards?.find((c) => c.personId === r.person!.id);
        if (!card)
          return {
            kind: 'text',
            text: `There is no card for ${r.person.firstName} in Drafts right now.`,
            href: '/inbox',
          };
        if (/^snooze$/i.test(m[1]!)) {
          const span = m[3]?.toLowerCase();
          const days =
            !span || span === 'a day' || span === 'tomorrow'
              ? 1
              : span === 'a week'
                ? 7
                : Number.parseInt(span, 10) || 1;
          return viaTool(
            'manage_suggestion',
            { suggestionId: card.id, action: 'snooze', days },
            undefined,
            'snooze a card',
          );
        }
        return viaTool(
          'dismiss_suggestion',
          { suggestionId: card.id, reason: 'not_now' },
          undefined,
          'dismiss a card',
        );
      }
      if (r.candidates.length) return ambiguous(m[2]!, r.candidates);
      return nobody(m[2]!);
    }
  }

  // "I sent it": a handed-off message went out
  {
    const m = text.match(
      /^(?:i sent (?:it|the (?:message|email|note|draft)) to|i (?:messaged|emailed) |mark (?:my |the )?(?:message|draft|email) (?:to|for) )\s*(.+?)(?: as sent)?$/i,
    );
    if (m) {
      const r = person(m[1]!);
      if (r.person) {
        const d = ctx.drafts?.find((x) => x.personId === r.person!.id && x.status === 'handed_off');
        if (d) return viaTool('confirm_handoff', { draftId: d.id }, undefined, 'log a sent message');
        return {
          kind: 'text',
          text: `Orbit is not waiting on a message to ${r.person.firstName}. If you sent something outside Orbit, move their chat instead, like: move ${r.person.firstName} to first message sent.`,
          href: `/people/${r.person.id}`,
        };
      }
      if (r.candidates.length) return ambiguous(m[1]!, r.candidates);
      return nobody(m[1]!);
    }
  }

  // autopilot: "send these on autopilot", "spread my emails over the week", "schedule my drafts, 4 a day"
  if (
    /\bauto ?pilot\b|\bspread (?:them|these|it all|my (?:drafts|emails|messages))(?: out)?\b|\b(?:schedule|space out) (?:my |the |these |all |all my )?(?:drafts|emails|messages)\b|\bsend (?:them|these|my drafts|my emails|all of them) (?:over|across|throughout) /i.test(
      text,
    )
  ) {
    const perDay = text.match(/\b(\d{1,2}) (?:a|per) day\b/i);
    return viaTool(
      'schedule_sends',
      perDay ? { perDay: Math.min(30, Math.max(1, Number(perDay[1]))) } : {},
      undefined,
      'send on autopilot',
    );
  }

  // send, or read, a draft that already exists
  {
    const send = text.match(
      /^(?:send|approve|ship)(?: off)?(?: the| my)?(?: (.*?))?\s*(?:draft|message|email|note)?\s+(?:to|for)\s+(.+)$/i,
    );
    const show = text.match(
      /^(?:show|open|read|see|view)(?: me)?(?: the| my)?(?: (.*?))?\s*(?:draft|message|email)s?\s+(?:to|for)\s+(.+)$/i,
    );
    const m = send ?? show;
    if (m) {
      const r = person(m[2]!);
      if (r.person) {
        const kind = m[1] ? findKind(m[1]) : undefined;
        const mine = (ctx.drafts ?? []).filter(
          (d) => d.personId === r.person!.id && d.status !== 'handed_off' && (!kind || d.kind === kind),
        );
        const d = mine[0];
        if (d && send) return viaTool('send_draft', { draftId: d.id }, undefined, 'send a draft');
        if (d) return viaTool('get_draft', { draftId: d.id }, undefined, 'open a draft');
        if (send || !(ctx.drafts ?? []).some((x) => x.personId === r.person!.id))
          // nothing written yet: start the draft; it still asks before anything is sent
          return viaTool(
            'create_draft',
            { kind: kind ?? 'outreach', personId: r.person.id },
            `There is no draft to ${r.person.firstName} yet, so here is one to read first.`,
            'start a draft',
          );
        return viaTool('list_drafts', { list: 'all', personId: r.person.id }, undefined, 'list drafts');
      }
      if (r.candidates.length) return ambiguous(m[2]!, r.candidates);
      return nobody(m[2]!);
    }
  }

  // add a person by hand: "add Jordan Lee at Figma, jordan@figma.com"
  {
    const m = text.match(
      /^(?:add|new|create)\s+(?:a\s+)?(?:person|contact|someone)(?:\s+named|\s+called)?[:,]?\s+(.+)$/i,
    );
    if (m) {
      let rest = m[1]!;
      const email = rest.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
      const url = rest.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w%-]+\/?/i)?.[0];
      for (const x of [email, url]) if (x) rest = rest.replace(x, ' ');
      rest = rest.replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim();
      const at = rest.match(/^(.+?)\s+(?:at|from)\s+(.+)$/i);
      const name = (at ? at[1]! : rest).trim();
      const input: Record<string, unknown> = { name };
      if (at) input.company = at[2]!.trim();
      if (email) input.email = email;
      if (url) input.linkedinUrl = url.startsWith('http') ? url : `https://${url}`;
      if (name && !email && !url)
        return {
          kind: 'text',
          text: `What's ${name}'s email or LinkedIn link? Orbit needs one to reach them. Add it like: add ${name}${at ? ` at ${at[2]!.trim()}` : ''}, ${name.split(' ')[0]!.toLowerCase()}@example.com.`,
        };
      if (name) return viaTool('add_person', input, undefined, 'add a person');
    }
  }

  // who went quiet
  if (
    /\b(went quiet|gone quiet|go quiet|quiet|ghosted|no (reply|replies|response|answer)|not (replied|responded|answered|heard)|haven'?t (replied|responded|heard|answered)|hasn'?t (replied|responded|answered)|never (replied|responded|answered|wrote back)|waiting (on|for) (a )?(reply|response|answer)|unanswered|who should i (follow up|bump|nudge))\b/i.test(
      lower,
    ) &&
    !/^(follow up|bump|nudge|ping|draft|write|move|put|set|mark|change)\b/i.test(lower)
  )
    return viaTool('list_pipeline', { quietOnly: true }, undefined, 'list who went quiet');

  // follow up with <name>
  {
    const m = /^remind me\b/.test(lower)
      ? null
      : lower.match(/^(?:follow up|follow-up|bump|nudge|ping|remind)\s+(?:with |on |to )?(.+)$/i);
    if (m) {
      const r = person(m[1]!);
      if (r.person)
        return viaTool('create_draft', { kind: 'bump', personId: r.person.id }, undefined, 'draft a bump');
      if (r.candidates.length) return ambiguous(m[1]!, r.candidates);
      return nobody(m[1]!);
    }
  }

  // the warm-up choice for a LinkedIn-only stranger: "warm up Noah first" or "write to Noah now, skip the warm-up"
  {
    const warm = text.match(/^warm up\s+(?:with\s+)?(.+?)(?:\s+first)?$/i);
    const now = text.match(
      /^(?:write to|message|email)\s+(.+?)\s+now(?:,?\s*(?:and\s+)?skip(?:ping)? the warm-?\s?up)?$/i,
    );
    const m = warm ?? now;
    if (m) {
      const r = person(m[1]!);
      if (r.person)
        return viaTool(
          'create_draft',
          { personId: r.person.id, warmUp: warm ? 'start' : 'skip' },
          undefined,
          warm ? 'start a warm-up' : 'start a draft',
        );
      if (r.candidates.length) return ambiguous(m[1]!, r.candidates);
      if (warm) return nobody(m[1]!);
    }
  }

  // drafts
  if (
    /^(my |the |show |show me |list |open |any )*(unsent( drafts| messages)?|drafts?|outbox|inbox|ready to send|messages to send|what('?s| is) (ready|waiting) to send)$/i.test(
      lower,
    )
  )
    return viaTool('list_drafts', { list: 'to_send' }, undefined, 'list drafts');

  // move <name> to <stage>
  {
    const explicit = text.match(
      /^(?:move|put|set|mark|change)\s+(?!(?:my |the |this |that )?(?:promise|note|card|draft|message|email|tone|style|weekly|cooldown|daily|limit|stripe deadline|deadline|target)\b)(.+?)\s+(?:to|as|into|in|->)\s+(.+)$/i,
    );
    const implicit = text.match(
      /^(.+?)\s+(?:is now\s+|has\s+|just\s+)?(replied|declined|scheduled|booked|said no|went quiet|passed|wrote back|got back to me)$/i,
    );
    // "Dan replied" only counts when Dan is a known person; "who replied" is a stage question handled below
    const m = explicit ?? (implicit && person(implicit[1]!).person ? implicit : null);
    if (m) {
      const stage = findStage(m[2]!);
      const r = person(m[1]!);
      if (stage && r.person)
        return viaTool('move_pipeline_stage', { personId: r.person.id, stage }, undefined, 'move a chat');
      if (stage && r.candidates.length) return ambiguous(m[1]!, r.candidates);
      if (
        stage &&
        !/\b(priority|deadline|target|people|orbit|contacts|tone|weekly|cooldown|limit)\b/i.test(m[2]!)
      )
        return nobody(m[1]!);
      if (
        r.person &&
        /^(move|put|mark|change)$/i.test(text.split(' ')[0]!) &&
        /^(?:the )?(?:stage|chat|column)?\s*\w+$/i.test(m[2]!.trim())
      )
        return choose(`Where does the chat with ${r.person.firstName} stand now?`, 'Pick a stage:', [
          { label: 'Replied', message: `Move ${r.person.displayName} to replied` },
          { label: 'Scheduled', message: `Move ${r.person.displayName} to scheduled` },
          { label: 'Done', message: `Move ${r.person.displayName} to completed` },
        ]);
    }
  }

  // note about <name>: <text>
  {
    const m = text.match(
      /^(?:add |save |take |write |log |new )?(?:a |quick )?note(?: about| for| on| re)?\s*(?:[:-]\s*(.*)|\s+(.+?)\s*[:-]\s*(.*)|\s+(.+))?$/i,
    );
    if (m) {
      const [, onlyText, who, body, rest] = m;
      if (who && body) {
        const r = person(who);
        if (r.person)
          return viaTool(
            'add_note',
            { text: body, personId: r.person.id, source: 'manual' },
            undefined,
            'save a note',
          );
        if (r.candidates.length) return ambiguous(who, r.candidates);
        return viaTool('add_note', { text: `${who}: ${body}`, source: 'manual' }, undefined, 'save a note');
      }
      const free = onlyText ?? rest;
      if (free?.trim()) {
        const r = person(free);
        if (r.person && !/\s/.test(free.trim()) === false && free.trim().split(' ').length <= 3)
          return {
            kind: 'text',
            text: `What should the note about ${r.person.displayName} say? Write it like: note about ${r.person.firstName}: she suggested the platform team.`,
            href: '/notes/new',
          };
        return viaTool('add_note', { text: free.trim(), source: 'manual' }, undefined, 'save a note');
      }
      return {
        kind: 'text',
        text: 'What should the note say? Write it like: note about {name}: she suggested the platform team. Or open the note page.',
        href: '/notes/new',
      };
    }
  }

  // the people picked on a card: "Add to People and find warm routes to each of: Dana Lee [rec li:1], Kai Ito"
  {
    const m = text.match(
      /^add (?:them |these |those )?to people(?:,? (?:and |then )?(find (?:warm )?routes to each(?: of(?: them)?)?|draft (?:a )?(?:messages?|notes?) to each(?: of(?: them)?)?))?[:,]?\s+(.+)$/i,
    );
    if (m && has('add_sourced')) {
      const then = m[1] ? (/route/i.test(m[1]) ? 'routes' : 'drafts') : undefined;
      const recs = [...m[2]!.matchAll(/\[rec ([^\]\s]+)\]/g)].map((x) => x[1]!);
      const names = m[2]!
        .replace(/\[rec [^\]]+\]/g, '')
        .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
        .map((s) => stripName(s))
        .filter(Boolean);
      if (recs.length)
        return viaTool(
          'add_sourced',
          { recommendationIds: recs, ...(then ? { next: then } : {}) },
          undefined,
          'add people from a search',
        );
      // everyone named is in Orbit already: straight to the routes or the drafts
      const found = names.map((n) => person(n));
      if (found.length && found.every((r) => r.person)) {
        const personIds = [...new Set(found.map((r) => r.person!.id))];
        if (then === 'drafts' && has('create_drafts'))
          return viaTool('create_drafts', { personIds }, undefined, 'draft several messages');
        if (then === 'routes')
          return viaTool('find_routes', { personIds }, undefined, 'find routes to several people');
        return {
          kind: 'text',
          text: `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} in your people already.`,
        };
      }
      const at = found.findIndex((r) => !r.person);
      if (at >= 0 && found[at]!.candidates.length) return ambiguous(names[at]!, found[at]!.candidates);
      if (at >= 0) return nobody(names[at]!);
    }
  }

  // routes to several people at once: "find warm routes to each of: Priya Ahmed and Elena Garcia"
  {
    const m = text.match(
      /^(?:find |show |get )?(?:the )?(?:warm )?(?:routes?|paths?|ways? in|intros?) to (?:each|all|both) of(?: them)?[:,]?\s+(.+)$/i,
    );
    if (m) {
      const names = m[1]!
        .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
        .map((s) => stripName(s))
        .filter(Boolean);
      const found = names.map((n) => person(n));
      if (names.length && found.every((r) => r.person))
        return viaTool(
          'find_routes',
          { personIds: [...new Set(found.map((r) => r.person!.id))] },
          undefined,
          'find routes to several people',
        );
      const at = found.findIndex((r) => !r.person);
      if (found[at]?.candidates.length) return ambiguous(names[at]!, found[at]!.candidates);
      if (names[at]) return nobody(names[at]!);
    }
  }

  // routes: who can introduce me to <person or company>
  {
    const m = text.match(
      /^(?:who (?:can|could) (?:warmly )?(?:introduce|intro|connect) me (?:to|with|at)|who (?:can|could) get me (?:a |an )?(?:warm )?(?:intro|introduction) (?:to|at|into)|(?:find |show |any |get )?(?:a |an |the |my )?(?:warm )?(?:routes?|paths?|way|intros?|introductions?) (?:to|into|at)|how (?:do|can|could|would) i (?:reach|get to|get into|get an intro to|get introduced to|get a warm intro to|connect with)|who do i know at|anyone (?:i know )?at|do i know anyone at|reach|get me (?:to|into))\s+(.+)$/i,
    );
    if (m) {
      const target = stripName(m[1]!);
      const r = person(target);
      if (r.person)
        return viaTool('find_routes', { personId: r.person.id }, undefined, 'find routes to a person');
      const company = ctx.companies.find((c) => c.toLowerCase() === target.toLowerCase()) ?? target;
      if (r.candidates.length && !ctx.companies.some((c) => c.toLowerCase() === target.toLowerCase()))
        return ambiguous(target, r.candidates);
      return viaTool('find_routes', { company }, undefined, 'find routes to a company');
    }
  }

  // an intro request through someone: "draft an intro request to Maya Chen for Daniel Okafor"
  {
    const m = text.match(
      /^(?:draft|write)\s+(?:an?\s+)?intro(?:duction)?\s+(?:request|ask)\s+to\s+(.+?)\s+(?:for|about)\s+(?:an\s+intro(?:duction)?\s+to\s+)?(.+)$/i,
    );
    if (m) {
      const via = person(m[1]!);
      const to = person(m[2]!);
      if (via.person && to.person)
        return viaTool(
          'create_draft',
          { kind: 'intro_request', personId: via.person.id, targetPersonId: to.person.id },
          undefined,
          'draft an intro request',
        );
      if (!via.person && via.candidates.length) return ambiguous(m[1]!, via.candidates);
      if (!to.person && to.candidates.length) return ambiguous(m[2]!, to.candidates);
      return nobody(via.person ? m[2]! : m[1]!);
    }
  }

  // several people at once: "draft a first message to each of: Priya Ahmed, Elena Garcia and Yuki Lopez"
  {
    const m = text.match(
      /^(?:draft|write)\s+(?:a |an )?(.*?)\s*(?:messages?\s+|notes?\s+|emails?\s+)?to\s+(each of(?: them)?[:,]?\s+|all of[:,]?\s+)?(.+)$/i,
    );
    if (m && has('create_drafts')) {
      const names = m[3]!
        .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
        .map((s) => stripName(s))
        .filter(Boolean);
      if (names.length >= 2 || (m[2] && names.length)) {
        const found = names.map((n) => person(n));
        if (found.every((r) => r.person)) {
          const kind = findKind(m[1] ?? '');
          return viaTool(
            'create_drafts',
            {
              personIds: [...new Set(found.map((r) => r.person!.id))],
              // a plain "message" lets Orbit pick each one from where that chat stands
              ...(kind && kind !== 'outreach' ? { kind } : {}),
            },
            undefined,
            'draft several messages',
          );
        }
        const at = found.findIndex((r) => !r.person);
        if (found[at]!.candidates.length) return ambiguous(names[at]!, found[at]!.candidates);
        return nobody(names[at]!);
      }
    }
  }

  // draft a <kind> to <name>
  {
    const m = text.match(
      /^(?:draft|write|compose|start|prepare|send|make|create)\s+(?:a |an |the |my )?(.*?)\s*(?:message |email |note |draft )?(?:to|for)\s+(.+)$/i,
    );
    const short = text.match(
      /^(thank|congratulate|congrats to|check in (?:with|on)|say thanks to|reply to|answer)\s+(.+)$/i,
    );
    if (m || short) {
      const kindText = m ? (m[1] ?? '') : short![1]!;
      const name = m ? m[2]! : short![2]!;
      const kind: MessageKind =
        findKind(kindText) ??
        (/^(check in)/i.test(kindText)
          ? 'nurture'
          : /^(reply|answer)/i.test(kindText)
            ? 'reply'
            : 'outreach');
      // a bare "write to Lena" names no kind: Orbit picks it from where the chat stands (a thank-you after a chat)
      const pick = /^write\s+to\s/i.test(text) && !kindText.trim();
      const r = person(name);
      if (r.person)
        return viaTool(
          'create_draft',
          pick ? { personId: r.person.id } : { kind, personId: r.person.id },
          undefined,
          'start a draft',
        );
      if (r.candidates.length) return ambiguous(name, r.candidates);
      return nobody(name);
    }
  }

  // the rest of the inventory's phrases (routerMore.ts)
  {
    const r = routeMore(text, lower, ctx, more);
    if (r) return r;
  }

  // LinkedIn import
  if (/linkedin/i.test(lower) && /\b(import|export|upload|connections|csv|zip|load|add)\b/i.test(lower)) {
    if (has('show_setup'))
      return setupLinkedin("Sure. Drop your LinkedIn export here and I'll bring your connections in.");
    return {
      kind: 'text',
      text: 'To import LinkedIn connections, use the + button and choose Import LinkedIn connections, or open Settings, Integrations. Orbit reads Connections.csv or the whole ZIP from your LinkedIn data export.',
      href: ctx.settingsHref,
    };
  }

  // pipeline, optionally by stage
  {
    const stage = findStage(lower);
    const pipelineWord =
      /\b(pipeline|chats?|stages?|conversations|list|show|who('s| is| are)|people|everyone|anyone|in)\b/i.test(
        lower,
      );
    if (
      /^(my |the |show |show me |list |open |see )*(pipeline|chats|stages|all (my )?chats|everything)$/i.test(
        lower,
      )
    )
      return viaTool('list_pipeline', {}, undefined, 'list the pipeline');
    if (stage && (pipelineWord || lower.split(' ').length <= 4) && !/\bto\b.*\bto\b/.test(lower)) {
      // "who is scheduled", "show replied", "chats in scheduling", "no response"
      const r = person(
        text.replace(new RegExp(`\\b(${STAGE_ALIASES[stage].map(esc).join('|')})\\b`, 'i'), ''),
      );
      if (!r.person || /\b(pipeline|chats?|stage|show|list|who)\b/i.test(lower))
        return viaTool('list_pipeline', { stage }, undefined, 'list a stage');
    }
  }

  // settings questions (before people, since "settings" is not a name)
  if (
    /\b(settings?|preferences?|configure|turn (on|off)|enable|disable|change my|update my|set my|where (do|can) i)\b/i.test(
      lower,
    )
  ) {
    const topic = SETTINGS_TOPICS.find((t) => t.re.test(lower));
    return topic
      ? { kind: 'text', text: topic.text, href: `/settings/${topic.section}` }
      : {
          kind: 'text',
          text: 'Settings has Profile, Goals, Integrations, Writing style, Limits and schedule, and Data and privacy.',
          href: '/settings',
        };
  }
  {
    const topic = SETTINGS_TOPICS.find((t) => t.re.test(lower));
    if (
      topic &&
      /\b(how|where|what|which|is|are|do|does|can|my)\b/i.test(lower) &&
      !/\b(who|draft|note|move)\b/i.test(lower)
    )
      return { kind: 'text', text: topic.text, href: `/settings/${topic.section}` };
  }

  // find or open a person by name
  {
    const m = text.match(
      /^(?:who is|who's|whos|show me|show|open up|open|find me|find|look up|lookup|tell me about|pull up|search for|search|get me|get|info on|details on|about)\s+(.+)$/i,
    );
    const name = m ? m[1]! : text;
    const r = person(name);
    if (r.person) return viaTool('get_person', { personId: r.person.id }, undefined, 'open a person');
    const company = ctx.companies.find((c) => c.toLowerCase() === stripName(name).toLowerCase());
    if (company) return viaTool('find_routes', { company }, undefined, 'open a company');
    if (r.candidates.length) return ambiguous(name, r.candidates);
    if (m) {
      if (has('search_people') && stripName(name).length >= 2)
        return viaTool('search_people', { query: stripName(name) }, undefined, 'search people');
      return nobody(name);
    }
  }

  // a how-it-works question that names nobody ("how does vc recruiting work", "what is a superday", "when do banks
  // recruit"): the playbook answers it in plain words (plan 28), the short version here and the whole section with a key
  if (
    has('lookup_playbook') &&
    (/^(?:how|what|when|why|which|is|are|do|does|should|can|whats|hows)\b/.test(lower) ||
      /\?\s*$/.test(lower)) &&
    !ctx.people.some((p) => p.displayName && lower.includes(p.displayName.toLowerCase())) &&
    findPlaybookSection(text)
  )
    return viaTool('lookup_playbook', { topic: text }, 'The short version.', 'check the playbook');

  // something the student told Orbit about themselves, not a request: acknowledged, not "I didn't catch that".
  // What Orbit keeps of it (a memory, a goal to track) is said under the reply, after the turn (afterTurn.ts).
  if (mayHoldFacts(text)) return { kind: 'text', text: 'Got it.' };

  // a keyboard mash, or frustration inside a longer message: a person would answer it, not offer a menu
  {
    const keep = new Set(
      [
        ...ctx.people.flatMap((p) => `${p.displayName} ${p.currentOrganizationRaw ?? ''}`.split(/\s+/)),
        ...ctx.companies,
      ]
        .map((w) => w.toLowerCase())
        .filter(Boolean),
    );
    const late = isNoise(raw, keep) ? 'noise' : soundsFrustrated(raw) ? 'frustrated' : undefined;
    if (late) {
      const r = answerSocial({ ...social, act: late }, kit);
      if (r) return r;
    }
  }

  return didYouMean(text, ctx, choose, withTool, HELP);
}

/** A message that asks for two things, split at "and then", "then", "and also" or "and" before a command word. */
export function splitAsks(text: string): string[] {
  const verbs =
    'draft|write|send|show|add|move|follow up|find|who|what|prep|note|thank|congratulate|snooze|open|ask|check in|tell me|list|remind|save|mark|look up|research';
  const parts = text
    .split(
      new RegExp(
        `\\s*(?:,\\s*)?(?:and then|then|and also|also|;)\\s+|\\s*,?\\s+and\\s+(?=(?:${verbs})\\b)`,
        'i',
      ),
    )
    .map((p) => p.trim().replace(/^(?:please|can you|could you)\s+/i, ''))
    .filter((p) => p.split(/\s+/).length >= 2);
  return parts.length > 1 && parts.length <= 3 ? parts : [text];
}

/** How Orbi says it did not follow a message, before the closest things it can do. */
export const NOT_FOLLOWED = "Hmm, I'm not sure what you mean.";
/** The router's "did not follow" lines, for tests and the offline suite to count. */
export const NOT_FOLLOWED_LEAD = /^(?:Hmm, I'm not sure what you mean|What should we do about )/;

/** Places to go when a message matched nothing: the person it names, or the closest things Orbit can do. */
const SUGGESTIONS: { label: string; message: string; words: string[] }[] = [
  {
    label: "What's on today",
    message: "What's on today?",
    words: ['today', 'day', 'do', 'plan', 'cards', 'brief', 'morning', 'agenda'],
  },
  {
    label: 'Show my pipeline',
    message: 'Show my pipeline',
    words: ['pipeline', 'chats', 'stage', 'board', 'where', 'stand', 'progress', 'everyone'],
  },
  {
    label: 'Who went quiet',
    message: 'Who went quiet?',
    words: ['quiet', 'reply', 'replied', 'ghost', 'heard', 'waiting', 'follow', 'bump'],
  },
  {
    label: 'Show my drafts',
    message: 'Show my drafts',
    words: ['draft', 'drafts', 'send', 'message', 'email', 'outbox', 'unsent', 'copy'],
  },
  {
    label: 'Who should I meet',
    message: 'Who should I meet?',
    words: ['meet', 'new', 'discover', 'recommend', 'suggest', 'people', 'network'],
  },
  {
    label: 'Find a warm intro',
    message: 'Who can introduce me to someone',
    words: ['intro', 'introduce', 'route', 'path', 'reach', 'map', 'connect', 'warm'],
  },
  {
    label: 'Prep for my next chat',
    message: 'Prep me for my next chat',
    words: ['prep', 'prepare', 'ready', 'questions', 'ask', 'chat', 'call', 'meeting', 'tomorrow'],
  },
  {
    label: 'Add a note',
    message: 'Add a note',
    words: ['note', 'notes', 'wrote', 'learned', 'remember', 'jot'],
  },
  {
    label: 'My goals',
    message: 'Show my goals',
    words: ['goal', 'goals', 'target', 'recruiting', 'aim', 'working'],
  },
  {
    label: 'Connect Gmail',
    message: 'Connect my Gmail',
    words: ['gmail', 'google', 'email', 'inbox', 'calendar', 'sync'],
  },
  {
    label: 'Import LinkedIn',
    message: 'Import my LinkedIn connections',
    words: ['linkedin', 'connections', 'import', 'csv', 'export'],
  },
  {
    label: 'Settings',
    message: 'Open settings',
    words: ['settings', 'tone', 'style', 'limit', 'profile', 'privacy', 'key'],
  },
];

function didYouMean(
  text: string,
  ctx: RouterContext,
  choose: (statement: string, question: string, options: ChoiceOption[]) => RouterIntent,
  withTool: (
    tool: 'offer_choices' | 'show_setup',
    input: Record<string, unknown>,
    lead: string,
    fallback: string,
  ) => RouterIntent,
  help: string,
): RouterIntent {
  const m = mentioned(text, ctx.people);
  if (m.person) {
    const p = m.person;
    const first = p.firstName || p.displayName;
    const scheduled = ctx.nextChat?.personId === p.id;
    return choose('', `What should we do about ${first}?`, [
      { label: `Open ${first}`, message: `Who is ${p.displayName}` },
      { label: `Write to ${first}`, message: `Write to ${p.displayName}` },
      scheduled
        ? { label: 'Prep for the chat', message: `Prep me for my chat with ${p.displayName}` }
        : { label: 'Find a warm intro', message: `Who can introduce me to ${p.displayName}` },
    ]);
  }
  const words = new Set(
    text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean)
      .flatMap((w) => [w, w.replace(/(ing|ed|es|s)$/, '')]),
  );
  const scored = SUGGESTIONS.map((s) => ({ s, n: s.words.filter((w) => words.has(w)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((x) => x.s);
  const picks = scored.length ? scored : SUGGESTIONS.slice(0, 3);
  return withTool(
    'offer_choices',
    { options: picks.map((s) => ({ label: s.label, message: s.message })) },
    `${NOT_FOLLOWED} Is it one of these?`,
    `${NOT_FOLLOWED} ${help}`,
  );
}
