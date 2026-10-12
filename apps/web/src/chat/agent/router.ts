import type { ChatStage, MessageKind } from '@orbit/core';
import type { ToolSpec } from '../types';
import { type MatchablePerson, resolvePerson } from './people-match';

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
  'Try: "what is on today", "show my pipeline", "who went quiet", "who is Priya", "draft a thank you to Priya", "follow up with Dan", "note about Priya: she suggested the PM team", "move Dan to scheduling", "who can introduce me to Stripe", "unsent drafts", or a settings question.';

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

  if (!text) return { kind: 'text', text: HELP_TEXT };

  // help
  if (/^(help|what can you do|what can i (say|ask|do)|commands?|options|menu)$/i.test(lower))
    return { kind: 'text', text: HELP_TEXT };

  // today's brief
  if (
    /^(today|brief|my brief|my day|agenda|what'?s? (on|up|new|next)( today| for today)?|what (is|should i do|do i do|do i have)( on| today| for today| now)*|show (me )?(today|my day|the brief)|good (morning|afternoon|evening)|start my day|plan for today|to ?do)$/i.test(
      lower,
    )
  )
    return viaTool('get_today_brief', {}, undefined, 'show the brief');

  // free-form questions and judgement calls need the model: say so before any pattern could half-match them
  if (NEEDS_MODEL.test(lower) && !/^(who is|who's|show|open|find|look ?up|tell me about)\b/i.test(lower))
    return refuse('That needs a Claude key: Orbit cannot reason about this on its own.');

  // who went quiet
  if (
    /\b(went quiet|gone quiet|go quiet|quiet|ghosted|no (reply|replies|response|answer)|not (replied|responded|answered|heard)|haven'?t (replied|responded|heard|answered)|hasn'?t (replied|responded|answered)|never (replied|responded|answered|wrote back)|waiting (on|for) (a )?(reply|response|answer)|unanswered|who should i (follow up|bump|nudge))\b/i.test(
      lower,
    ) &&
    !/^(follow up|bump|nudge|ping|draft|write)\b/i.test(lower)
  )
    return viaTool('list_pipeline', { stage: 'no_response' }, undefined, 'list who went quiet');

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
    return viaTool('list_drafts', { status: 'draft' }, undefined, 'list drafts');

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
        return viaTool(
          'find_routes_to_person',
          { personId: r.person.id },
          undefined,
          'find routes to a person',
        );
      const company = ctx.companies.find((c) => c.toLowerCase() === target.toLowerCase()) ?? target;
      if (r.candidates.length && !ctx.companies.some((c) => c.toLowerCase() === target.toLowerCase()))
        return ambiguous(target, r.candidates);
      return viaTool('find_routes_to_company', { company }, undefined, 'find routes to a company');
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
  if (/linkedin/i.test(lower) && /\b(import|export|upload|connections|csv|zip|load|add)\b/i.test(lower))
    return {
      kind: 'text',
      text: 'To import LinkedIn connections, use the + button and choose LinkedIn export, or open Settings, Integrations. Orbit reads the Connections file from your LinkedIn data export.',
      href: ctx.settingsHref,
    };

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
    if (r.candidates.length) return ambiguous(name, r.candidates);
    if (m) {
      if (has('search_people') && stripName(name).length >= 2)
        return viaTool('search_people', { query: stripName(name) }, undefined, 'search people');
      return nobody(name);
    }
  }

  return refuse('I did not understand that. ' + HELP_TEXT);
}
