import type { ChatStage, MessageKind } from '@orbit/core';
import type { ChoiceOption, ToolSpec } from '../types';
import { type MatchablePerson, resolvePerson } from './people-match';
import { peopleWaiting } from './setup';

/**
 * The no-key path: a deterministic intent router over the same tool registry. It is a table of patterns, not an
 * understanding of language. It handles the common commands (brief, pipeline by stage, who went quiet, find a
 * person, draft a kind of message to a person, add a note, move a chat, routes to a person or company, LinkedIn
 * import, settings questions) and answers everything else honestly: it says what needs a Claude key and where to add
 * one. It never pretends to have understood.
 */

export type RouterIntent =
  | { kind: 'tool'; tool: string; input: Record<string, unknown>; lead?: string }
  | { kind: 'text'; text: string; href?: string }
  | { kind: 'refuse'; text: string; href?: string };

export interface RouterContext {
  registry: ReadonlyMap<string, ToolSpec>;
  people: MatchablePerson[];
  /** known company names (target companies and organizations), for "routes to <company>" */
  companies: string[];
  /** open Today cards, so "snooze Priya's card" can name one */
  cards?: { id: string; personId?: string; kind: string }[];
  /** the student's drafts that are not sent yet (draft, failed, handed_off), newest first */
  drafts?: { id: string; personId: string; status: string; kind: string }[];
  /** the person of the next booked chat, for "prep me for my next chat" */
  nextChat?: { personId: string };
  /** the student's first name, for a warm greeting */
  firstName?: string;
  /** how many people have a message waiting on the student today (default: counted from `cards`) */
  waiting?: number;
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
  /^(hey|hi|hello|ok|okay|please|orbit|can you|could you|would you|will you|i want to|i'd like to|i need to|let's|lets|just)[,!.]?\s+/i;

/** "Hey Orbit, can you show my pipeline" -> "show my pipeline". */
function stripChatter(text: string): string {
  let t = text;
  for (let i = 0; i < 4 && CHATTY_PREFIX.test(t); i++) t = t.replace(CHATTY_PREFIX, '');
  return t.trim();
}

function stripName(raw: string): string {
  return raw
    .replace(/^(with|to|for|about|on|up with)\s+/i, '')
    .replace(/^(a|an|the|my)\s+/i, '')
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

function findKind(text: string): MessageKind | undefined {
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

const GREETING =
  /^(hey|hi|hello|yo|howdy|hiya|heya|sup|hey hey|good (morning|afternoon|evening))( there| orbit| friend| everyone)?$/;
const WHO_ARE_YOU = /^(who are you|what are you|who is orbit|what is orbit|what'?s orbit|what do you do)$/;
const WHAT_CAN_YOU_DO =
  /^(help|help me|what can you do|what can you do for me|what can i (say|ask|do)|how does this work|how do i start|where do i start)$/;
const THANKS = /^(thanks|thank you|thx|ty|cheers|many thanks|thanks a lot|thank you so much|appreciate it)$/;
const OK = /^(ok|okay|k|kk|cool|great|nice|awesome|perfect|got it|sounds good|alright|sweet|neat)$/;
const NOT_NOW =
  /^(not now|maybe later|later|no|nope|no thanks|nah|i'?m good|im good|all good|nothing|never ?mind|not yet|skip)$/;
const YES =
  /^(show me|yes|yeah|yep|yup|sure|ok show me|go ahead|let'?s do it|let'?s go|do it|sounds good show me)$/;
const ADD_SOMEONE =
  /^(add|new|log) (someone|somebody|a person|a contact|a new person)( (i|we) (met|know|talked to|spoke to))?$|^(i )?(met|know) (someone|somebody)( new)?$/;

/** Patterns that only a model could serve: say so instead of guessing. */
const NEEDS_MODEL =
  /\b(why|should i(?! (follow up|bump|nudge))|what do you think|do you think|rewrite|reword|shorter|longer|summari[sz]e|explain|compare|which (one|of)|best|recommend|advice|advise|strategy|plan for|help me (decide|think|write|figure)|what would you|how should|is it (ok|okay|fine|rude|too)|improve|polish|translate|make (it|this)|tips?)\b/i;

export function routeUtterance(raw: string, ctx: RouterContext): RouterIntent {
  const text = stripChatter(clean(raw));
  const lower = text.toLowerCase();
  const has = (tool: string) => ctx.registry.has(tool);

  const refuse = (why: string): RouterIntent => ({
    kind: 'refuse',
    text: `${why} ${ctx.modeNote}`,
    href: ctx.settingsHref,
  });
  const missing = (what: string): RouterIntent => ({
    kind: 'refuse',
    text: `Orbit cannot ${what} from the chat yet. ${HELP_TEXT}`,
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
        text: `Orbit's command list is out of step with its ${tool.replace(/_/g, ' ')} tool, so this cannot run right now. ${HELP_TEXT}`,
      };
    return { kind: 'tool', tool, input: parsed.data as Record<string, unknown>, lead };
  };
  const person = (name: string) => resolvePerson(ctx.people, stripName(name));
  const nobody = (name: string): RouterIntent => ({
    kind: 'text',
    text: `I could not find anyone called "${stripName(name)}" in your people. Check the spelling, or add them from the People page.`,
    href: '/people',
  });
  const ambiguous = (name: string, candidates: MatchablePerson[]): RouterIntent =>
    has('search_people')
      ? viaTool('search_people', { query: stripName(name) }, 'More than one person matches. Pick one:')
      : {
          kind: 'text',
          text: `More than one person matches "${stripName(name)}": ${candidates.map((p) => p.displayName).join(', ')}. Say the full name.`,
        };

  // ---- small talk: short, warm, one next step. A tap-to-answer reply when the tool exists, plain words when not. ----
  const name = ctx.firstName?.trim();
  const humans = ctx.people.filter((p) => !p.hiddenAt).length;
  const empty = humans === 0;
  const waiting = ctx.waiting ?? peopleWaiting(ctx.cards ?? []);
  const unsent = (ctx.drafts ?? []).filter((d) => d.status === 'draft').length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const hello = (word: string) => (name ? `${word} ${name}.` : `${word} there.`);

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
      `${statement} ${question}`,
      `${[statement, kept].filter(Boolean).join(' ')} Say "${options[0]!.message}" and I'll take it from there.`,
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
    if (waiting > 0)
      return {
        statement: `You've got ${plural(waiting, 'person', 'people')} waiting on a message today.`,
        question: 'Want to start there?',
        options: [
          { label: 'Show me', message: "What's on today?" },
          { label: 'Not now', message: 'Not now' },
        ],
      };
    if (unsent > 0)
      return {
        statement: `You've got ${plural(unsent, 'draft', 'drafts')} ready for a look.`,
        question: 'Want to start there?',
        options: [
          { label: 'Show me', message: 'Show my drafts' },
          { label: 'Not now', message: 'Not now' },
        ],
      };
    return {
      statement: 'Nothing is waiting on you today.',
      question: 'Want to see where your chats stand?',
      options: [
        { label: 'Show me', message: 'Show my pipeline' },
        { label: 'Not now', message: 'Not now' },
      ],
    };
  };
  const EMPTY_START =
    "Easiest first step is your LinkedIn connections. Drop the export here when you're ready.";
  const casual = text0(raw);

  if (GREETING.test(casual)) {
    const word = /^good (morning|afternoon|evening)/.test(casual)
      ? casual.replace(/ (there|orbit|friend|everyone)$/, '')
      : 'Hey';
    const hi = hello(word.charAt(0).toUpperCase() + word.slice(1));
    if (empty) return setupLinkedin(`${hi} ${EMPTY_START}`);
    const m = bestMove();
    return choose(hi, `${m.statement} ${m.question}`, m.options);
  }
  if (WHO_ARE_YOU.test(casual)) {
    const intro =
      "I'm Orbit, your networking copilot. I help you reach out to people and keep every chat moving.";
    if (empty) return setupLinkedin(`${intro} ${EMPTY_START}`);
    const m = bestMove();
    return choose(intro, `${m.statement} ${m.question}`, m.options);
  }
  if (WHAT_CAN_YOU_DO.test(casual)) {
    const intro = 'I find who to message, write the note, and keep track of every chat.';
    if (empty) return setupLinkedin(`${intro} ${EMPTY_START}`);
    return choose(intro, 'What sounds useful?', [
      { label: "What's on today", message: "What's on today?" },
      { label: 'Who went quiet', message: 'Who went quiet?' },
      { label: 'Where my chats stand', message: 'Show my pipeline' },
    ]);
  }
  if (THANKS.test(casual) || OK.test(casual)) {
    const lead = THANKS.test(casual) ? 'Anytime.' : 'Okay.';
    if (empty) return setupLinkedin(`${lead} ${EMPTY_START}`);
    const m = bestMove();
    return choose(lead, `${m.statement} ${m.question}`, m.options);
  }
  if (NOT_NOW.test(casual)) return { kind: 'text', text: "No problem. I'm here whenever you want me." };
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

  if (!text) return { kind: 'text', text: HELP_TEXT };

  // help
  if (/^(commands?|options|menu|list of commands)$/i.test(lower)) return { kind: 'text', text: HELP_TEXT };

  // today's brief
  if (
    /^(today|brief|my brief|my day|agenda|what'?s? (on|up|new|next)( today| for today)?|what (is|should i do|do i do|do i have)( on| today| for today| now)*|show (me )?(today|my day|the brief)|start my day|plan for today|to ?do)$/i.test(
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

  // free-form questions and judgement calls need the model: say so before any pattern could half-match them
  if (NEEDS_MODEL.test(lower) && !/^(who is|who's|show|open|find|look ?up|tell me about)\b/i.test(lower))
    return refuse('That needs a Claude key: Orbit cannot reason about this on its own.');

  // prep for a chat with someone
  {
    const m = text.match(
      /^(?:prep(?:are)?(?: me)?(?: for)?(?: my)?(?: (?:coffee )?chat| call| meeting)?(?: with)?|get me ready for(?: my)?(?: chat| call)?(?: with)?|prep notes for)\s+(.+)$/i,
    );
    if (m && /^(my )?next( coffee)?( chat| call| meeting)?$/i.test(m[1]!.trim())) {
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
      /^(?:what do (?:i|we) know about|what does orbit know about|facts (?:about|on|for)|notes on|what did (?:i|we) learn from|remind me about)\s+(.+)$/i,
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
  if (/^(?:sync|refresh|check)(?: my)? (?:google|gmail|email|inbox|calendar)$/i.test(lower))
    return viaTool('sync_google', {}, undefined, 'sync Google');

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
    const m = text.match(/^(?:hide|mute)\s+(.+?)(?:\s+from (?:my )?(?:lists|people|everything))?$/i);
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
          text: 'Say whose move to undo, like: undo the move for Dan.',
          href: '/pipeline',
        };
      const r = person(m[1]);
      if (r.person) return viaTool('undo_stage_move', { personId: r.person.id }, undefined, 'undo a move');
      if (r.candidates.length) return ambiguous(m[1], r.candidates);
      return nobody(m[1]);
    }
  }

  // a Today card: snooze or dismiss it
  {
    const m = text.match(
      /^(snooze|dismiss|skip|remove|hide)(?: the)?(?: card| suggestion)?(?: (?:for|about|on))?\s+(.+?)(?:'s)?(?: card| suggestion)?(?: for (a day|a week|\d+ days?|tomorrow))?$/i,
    );
    if (m && /^(snooze|dismiss|skip)$/i.test(m[1]!)) {
      const r = person(m[2]!);
      if (r.person) {
        const card = ctx.cards?.find((c) => c.personId === r.person!.id);
        if (!card)
          return {
            kind: 'text',
            text: `There is no card for ${r.person.firstName} on Today right now.`,
            href: '/today',
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
        if (send)
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
      if (name) return viaTool('add_person', input, undefined, 'add a person');
    }
  }

  // who went quiet
  if (
    /\b(went quiet|gone quiet|go quiet|quiet|ghosted|no (reply|replies|response|answer)|not (replied|responded|answered|heard)|haven'?t (replied|responded|heard|answered)|hasn'?t (replied|responded|answered)|never (replied|responded|answered|wrote back)|waiting (on|for) (a )?(reply|response|answer)|unanswered|who should i (follow up|bump|nudge))\b/i.test(
      lower,
    ) &&
    !/^(follow up|bump|nudge|ping|draft|write)\b/i.test(lower)
  )
    return viaTool('list_pipeline', { quietOnly: true }, undefined, 'list who went quiet');

  // follow up with <name>
  {
    const m = lower.match(/^(?:follow up|follow-up|bump|nudge|ping|remind)\s+(?:with |on |to )?(.+)$/i);
    if (m) {
      const r = person(m[1]!);
      if (r.person)
        return viaTool('create_draft', { kind: 'bump', personId: r.person.id }, undefined, 'draft a bump');
      if (r.candidates.length) return ambiguous(m[1]!, r.candidates);
      return nobody(m[1]!);
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
    const explicit = text.match(/^(?:move|put|set|mark|change)\s+(.+?)\s+(?:to|as|into|in|->)\s+(.+)$/i);
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
      if (stage) return nobody(m[1]!);
      if (r.person || r.candidates.length)
        return {
          kind: 'text',
          text: `I know who, but not which stage. Stages are: ${(Object.keys(STAGE_ALIASES) as ChatStage[]).map(stageLabel).join(', ')}.`,
        };
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
        text: 'What should the note say? Write it like: note about Priya: she suggested the platform team. Or open the note page.',
        href: '/notes/new',
      };
    }
  }

  // routes: who can introduce me to <person or company>
  {
    const m = text.match(
      /^(?:who can (?:introduce|intro|connect) me (?:to|with|at)|(?:find |show |any )?(?:a |the |warm )?(?:routes?|paths?|way|intro|introduction) (?:to|into|at)|how (?:do|can|could|would) i (?:reach|get to|get into|get an intro to|get introduced to|get a warm intro to|connect with)|who do i know at|anyone (?:i know )?at|do i know anyone at|reach|get me (?:to|into))\s+(.+)$/i,
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
      const r = person(name);
      if (r.person)
        return viaTool('create_draft', { kind, personId: r.person.id }, undefined, 'start a draft');
      if (r.candidates.length) return ambiguous(name, r.candidates);
      return nobody(name);
    }
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
      /^(?:who is|who's|whos|show|show me|open|find|look up|lookup|tell me about|pull up|search|search for|get|info on|details on|about)\s+(.+)$/i,
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

  return refuse('I did not understand that. ' + HELP_TEXT);
}
