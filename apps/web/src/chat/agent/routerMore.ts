import type { ChatStage, MessageKind } from '@orbit/core';
import type { ChoiceOption } from '../types';
import { type MatchablePerson, resolvePerson } from './people-match';
import type { RouterContext, RouterIntent } from './router';
import { shortenMessage } from './shorten';

/**
 * More of the no-key router's phrases: the capability inventory's requests that the first table did not cover
 * (card buttons said in words, times, relationships, targets, limits, style, the resume, Claude settings, setup,
 * notes and the map's gestures), and a way to find the person a sentence is about when the name is not where a
 * pattern expects it. `routeEarly` runs before the "needs a Claude key" check, for requests that sound like
 * judgement calls but are not ("what should I send Omar next"); `routeMore` runs after every other pattern.
 */
export interface MoreHelpers {
  viaTool: (tool: string, input: Record<string, unknown>, lead?: string, what?: string) => RouterIntent;
  person: (name: string) => { person?: MatchablePerson; candidates: MatchablePerson[] };
  nobody: (name: string) => RouterIntent;
  ambiguous: (name: string, candidates: MatchablePerson[]) => RouterIntent;
  findKind: (text: string) => MessageKind | undefined;
  findStage: (text: string) => ChatStage | undefined;
  choose: (statement: string, question: string, options: ChoiceOption[]) => RouterIntent;
  setupGmail: (statement: string) => RouterIntent;
  setupLinkedin: (statement: string) => RouterIntent;
  setup: (what: 'google' | 'linkedin' | 'claude_key' | 'resume', statement: string) => RouterIntent;
}

/** Words that are names in some people's lists but carry meaning in a request: never read as a person alone. */
const NOT_A_NAME = new Set(
  'a an the my me i you it this that these those them her him his their our we us to for with at from in on of and or but so if then now today tomorrow week day days time note notes draft drafts message chat call card cards new next last first second third all every everyone someone anyone people person who what when where why how can could would should will may might do does did is are was were be been just also only still yet again back up down out off over more less most least some any each both one two three four five top best good great warm cold close quiet sent send reply replied done grace will may june april august hope joy faith rose summer autumn page link email linkedin map board table list view pipeline stage stages remind mark set move open show find add write thank follow check ask please thanks ok okay yes no not hey hi hello orbit'.split(
    ' ',
  ),
);

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * The person a sentence is about, wherever the name sits: the longest run of words (three, two, one) that is a
 * person's full name, first name or last name. One word that is also an everyday word ("will", "grace") never counts.
 */
export function mentioned(
  text: string,
  people: MatchablePerson[],
): { person?: MatchablePerson; candidates: MatchablePerson[]; name?: string } {
  const words = text
    .replace(/[’]/g, "'")
    .split(/[^\p{L}\p{N}'-]+/u)
    .map((w) => w.replace(/'s$/i, ''))
    .filter(Boolean);
  const names = new Set<string>();
  for (const p of people) {
    names.add(fold(p.displayName));
    names.add(fold(p.firstName));
    if (p.lastName) names.add(fold(p.lastName));
  }
  for (let n = 3; n >= 1; n--)
    for (let i = 0; i + n <= words.length; i++) {
      const run = words.slice(i, i + n).join(' ');
      const key = fold(run);
      if (!names.has(key)) continue;
      if (n === 1 && NOT_A_NAME.has(key)) continue;
      const r = resolvePerson(people, run);
      if (r.person || r.candidates.length) return { ...r, name: run };
    }
  return { candidates: [] };
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Thursday at 2pm", "tomorrow 10am", "Oct 9 at 3:30 pm", "Friday noon": a local date and time, or undefined. */
export function whenFrom(text: string, now: Date): { at?: Date; dayOnly?: boolean } | undefined {
  const t = text.toLowerCase();
  let day: Date | undefined;
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  if (/\btoday\b|\btonight\b|\bthis (morning|afternoon|evening)\b/.test(t)) day = new Date(base);
  else if (/\btomorrow\b/.test(t)) {
    day = new Date(base);
    day.setDate(day.getDate() + 1);
  } else {
    const wd = t.match(
      /\b(next )?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day|sday|nesday|rsday|urday)?\b/,
    );
    if (wd) {
      const target = WEEKDAYS.findIndex((w) => w.startsWith(wd[2]!.slice(0, 3)));
      day = new Date(base);
      let diff = (target - day.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      if (wd[1] && diff < 7) diff += 0;
      day.setDate(day.getDate() + diff);
    }
    const md = t.match(/\b([a-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?\b/);
    const month = md ? MONTHS.indexOf(md[1]!) : -1;
    if (md && month >= 0) {
      day = new Date(base.getFullYear(), month, Number(md[2]));
      if (day.getTime() < base.getTime()) day.setFullYear(day.getFullYear() + 1);
    }
  }
  const tm = t.match(
    /\b(?:at |@ ?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b|\bat (\d{1,2})(?::(\d{2}))?\b|\b(noon|midday)\b/,
  );
  if (!day && !tm) return undefined;
  if (!day) return undefined;
  if (!tm) return { at: day, dayOnly: true };
  let hour: number;
  let minute = 0;
  if (tm[6]) hour = 12;
  else {
    hour = Number(tm[1] ?? tm[4]);
    minute = Number(tm[2] ?? tm[5] ?? 0);
    const ampm = tm[3]?.replace(/\./g, '');
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    // "at 2" means the afternoon; "at 9" the morning
    if (!ampm && hour >= 1 && hour <= 7) hour += 12;
  }
  const at = new Date(day);
  at.setHours(hour, minute, 0, 0);
  return { at };
}

function minutesFrom(text: string): number | undefined {
  const m = text.match(/\b(\d{2,3})\s*(?:minutes?|mins?)\b|\b(an|one|1) hour\b|\bhalf an hour\b/i);
  if (!m) return undefined;
  if (/half an hour/i.test(m[0])) return 30;
  if (m[2]) return 60;
  return Number(m[1]);
}

const firstOf = (p: MatchablePerson) => p.firstName || p.displayName.split(' ')[0]!;

/** Requests that sound like a judgement call but are something the router can do. */
export function routeEarly(
  text: string,
  lower: string,
  ctx: RouterContext,
  h: MoreHelpers,
): RouterIntent | undefined {
  const who = () => mentioned(text, ctx.people);
  const withPerson = (run: (p: MatchablePerson) => RouterIntent): RouterIntent | undefined => {
    const m = who();
    if (m.person) return run(m.person);
    if (m.candidates.length && m.name) return h.ambiguous(m.name, m.candidates);
    return undefined;
  };

  // a follow-up with nothing before it: ask what it points at, never guess
  if (
    /^(?:send|approve|ship|discard|delete|scrap|show|open|read|shorten|trim|drop|resend|copy)(?: it| this| that| the draft| the message)?(?: now| as is| as drafted| again)?$|^(?:make (?:it|this) )?shorter$|^make (?:it|this) (?:shorter|a (?!bit|little|lot).+)$|^(?:switch|change|turn) (?:it|this) (?:to|into) .+$|^write a .+ (?:rather than|instead of) .+$|^that draft is bad,? drop it$|^where do i paste (?:this|it)$|^(?:what subject will this use|does this reply in the thread|is this going as a reply or a new email)$/.test(
      lower,
    )
  ) {
    const open = (ctx.drafts ?? []).filter((d) => d.status === 'draft' || d.status === 'failed');
    if (open.length)
      return h.viaTool(
        'list_drafts',
        { list: 'to_send' },
        'Which draft? Open it here, then tell me what to do with it.',
        'list drafts',
      );
    return { kind: 'text', text: 'There is no draft yet. Say who to write to, like: write to {name}.' };
  }
  if (
    /^(?:the |option |number |#)?(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|[1-5])(?: one| option)?$/.test(
      lower,
    )
  )
    return {
      kind: 'text',
      text: 'Which list? Show one first, like: who went quiet, or who do I know at {company}.',
    };
  if (/^(?:and|what about|how about) (?:her|him|them|that one|this one)$/.test(lower))
    return { kind: 'text', text: 'Who do you mean? Say their name, like: who is {name}.' };
  if (/^(?:revert|undo) (?:that|it)$/.test(lower))
    return { kind: 'text', text: 'What should I undo? Say it like: undo the move for {name}.' };
  if (/^do the (?:linkedin )?warm-?up(?: first)?$/.test(lower))
    return { kind: 'text', text: 'Who should I warm up? Say it like: warm up {name} first.' };
  if (
    /^(?:update|change|set) when the chat is$|^(?:the chat|it) happened (?:this morning|today|yesterday|earlier)$/.test(
      lower,
    )
  )
    return {
      kind: 'text',
      text: 'Which chat, and when? Say it like: the chat with {name} happened, or my chat with {name} is Thursday at 2pm.',
    };

  // a first-run hint: "hide the how-today-works tip", "stop showing the board hint"
  if (/\b(hint|tip)\b/.test(lower) && /\b(hide|stop showing|dismiss|close|got it)\b/.test(lower))
    return h.viaTool(
      'update_settings',
      { section: 'hints', hintId: /\b(board|pipeline)\b/.test(lower) ? 'pipeline' : 'today' },
      undefined,
      'close a hint',
    );

  // a summary or talking points, rebuilt from what Orbit knows: "rewrite what you know about Omar"
  if (
    /\b(summary|talking points|what you know about)\b/.test(lower) &&
    /^(?:refresh|update|rewrite|redo|rebuild)\b/.test(lower)
  ) {
    const m = mentioned(text, ctx.people);
    if (m.person)
      return h.viaTool(
        'update_person',
        { personId: m.person.id, refreshSummary: true },
        undefined,
        'refresh a summary',
      );
  }

  // a wrong fact: "that advice fact is wrong, drop it" (said before the judgement words catch "advice")
  if (
    /\bfact\b|\bhometown\b/.test(lower) &&
    /^(?:delete|remove|drop|that .+ is wrong|the .+ is wrong)/.test(lower)
  ) {
    const m = mentioned(text, ctx.people);
    if (m.person)
      return h.viaTool(
        'get_person',
        { personId: m.person.id, include: ['facts'] },
        'Which fact? Delete it from their profile, under Facts.',
        'open a person',
      );
    return {
      kind: 'text',
      text: 'Whose fact? Open them and delete it under Facts, or say: what do I know about {name}.',
    };
  }

  // memory, said plainly: "what did I tell you about Maya", "do you remember my traction numbers", "Lauren prefers LinkedIn"
  {
    const recall = text.match(
      /^(?:what did i tell you about|do you remember|what do you know about my)\s+(.+)$/i,
    );
    if (recall) {
      const p = mentioned(recall[1]!, ctx.people);
      return h.viaTool(
        'recall',
        { query: p.person?.displayName ?? recall[1]!.trim(), ...(p.person ? { personId: p.person.id } : {}) },
        undefined,
        'recall',
      );
    }
    const prefers = text.match(/^(.+?) (?:prefers|likes|would rather|hates|is better on|only uses) (.+)$/i);
    if (prefers) {
      const p = h.person(prefers[1]!);
      if (p.person)
        return h.viaTool(
          'remember',
          { text: text.slice(0, 300), kind: 'person_fact', personId: p.person.id },
          undefined,
          'remember something',
        );
    }
    if (
      /^(?:our|my) (?:traction|revenue|users|customers|startup|company|product|pitch|deck|metric|numbers?)\b.+\bis\b/.test(
        lower,
      )
    )
      return h.choose('Want me to remember that?', 'It helps the drafts.', [
        {
          label: 'Remember it',
          message: `Remember that ${text.replace(/^(our|my)\b/i, (w) => w.toLowerCase())}`,
        },
        { label: 'Not now', message: 'Not now' },
      ]);
  }
  {
    const m = text.match(
      /^ask (.+?) for (?:a |an )?(referral|intro(?:duction)?|advice|coffee chat|coffee|chat|call|help|their advice)$/i,
    );
    if (m) {
      const r = h.person(m[1]!);
      const kind = /referral/i.test(m[2]!) ? 'referral_ask' : undefined;
      if (r.person && /intro/i.test(m[2]!))
        return {
          kind: 'text',
          text: `An intro to whom? Say it like: ask ${firstOf(r.person)} to introduce me to {name2}.`,
        };
      if (r.person)
        return h.viaTool(
          'create_draft',
          { personId: r.person.id, ...(kind ? { kind } : {}) },
          undefined,
          'start a draft',
        );
      if (r.candidates.length) return h.ambiguous(m[1]!, r.candidates);
      return h.nobody(m[1]!);
    }
    const bare = text.match(/^ask ([\p{L}'-]+(?: [\p{L}'-]+)?)$/iu);
    if (bare) {
      const r = h.person(bare[1]!);
      if (r.person)
        return h.choose(`Ask ${firstOf(r.person)} what?`, 'Pick one:', [
          { label: `Write to ${firstOf(r.person)}`, message: `Write to ${r.person.displayName}` },
          { label: 'Ask for a referral', message: `Ask ${r.person.displayName} for a referral` },
          { label: 'Ask for an intro', message: `Who can ${r.person.displayName} introduce me to` },
        ]);
    }
  }

  // a LinkedIn comment for a warm-up: "write a comment for their post about new analysts shipping in week one"
  {
    const comment = text.match(
      /^(?:write|draft|suggest|help me (?:write|with)|give me)?\s*(?:a |an )?(?:linkedin )?comment(?: for| on| to)?(?: (?:their|his|her|.+?'s|a|the))? post(?: (?:about|on|saying|that says) (.+))?$/i,
    );
    if (comment?.[1])
      return h.viaTool(
        'draft_warmup_comment',
        { postClaim: comment[1].trim() },
        undefined,
        'draft a comment',
      );
    if (comment || /^(?:help me comment on|suggest a linkedin comment|comment on)\b/.test(lower))
      return {
        kind: 'text',
        text: 'What does the post say? Tell me in a line, like: write a comment for their post about shipping in week one.',
      };
  }

  // the line a draft is missing: "the why-them line is: I read your post", "my update is that I switched to PM"
  {
    const m = text.match(
      /^(?:the )?why[- ]?them(?: line)? is:?\s+(.+)$|^(?:my|the) update is:?\s+(?:that\s+)?(.+)$|^i'?m applying (?:to|for) (.+?)(?:,.*)?$/i,
    );
    if (m) {
      const open = (ctx.drafts ?? []).filter((d) => d.status === 'draft');
      if (open.length === 1) {
        const input = m[1] ? { connection: m[1] } : m[2] ? { update: m[2] } : { role: m[3] };
        return h.viaTool(
          'redraft_with_inputs',
          { draftId: open[0]!.id, ...input },
          undefined,
          'redraft with your line',
        );
      }
      return h.viaTool(
        'list_drafts',
        { list: 'to_send' },
        open.length ? 'Which draft is that for? Open it and add the line in the card.' : undefined,
        'list drafts',
      );
    }
  }

  // "send the invite for Thursday", "book Tuesday at 10": a time for a chat, never a person called Thursday
  if (/^(?:send|book|put)\b.*\b(invite|calendar)\b|^book (?:mon|tue|wed|thu|fri|sat|sun)/.test(lower)) {
    const r = mentioned(text, ctx.people);
    const when = whenFrom(text, ctx.now ?? new Date());
    if (r.person && when?.at && !when.dayOnly)
      return h.viaTool(
        'schedule_chat',
        { personId: r.person.id, startAt: when.at.toISOString() },
        undefined,
        'set the chat time',
      );
    if (ctx.account)
      return h.viaTool(
        'list_replies',
        { replyClass: 'scheduling' },
        'Pick the time on the reply, then confirm the booking there.',
        'list replies',
      );
    return {
      kind: 'text',
      text: r.person
        ? `When is the chat with ${firstOf(r.person)}? Say a day and time, like: my chat with ${firstOf(r.person)} is Thursday at 2pm.`
        : 'Whose chat, and when? Say it like: my chat with {name} is Thursday at 2pm.',
    };
  }

  // "who should I reach out to for PM at Stripe", "who at Figma should I talk to": the people there
  {
    const m =
      text.match(
        /^who (?:should|could|can) i (?:reach out to|talk to|contact|email|message|network with|write to|ask)(?: (?:for|about) .+?)? (?:at|from|in) (.+)$/i,
      ) ??
      text.match(
        /^who (?:at|from) (.+?) should i (?:reach out to|talk to|contact|email|message|write to)(?: .*)?$/i,
      );
    if (m) {
      const name = m[1]!.replace(/[?.!]+$/, '').trim();
      const company = ctx.companies.find((c) => c.toLowerCase() === name.toLowerCase()) ?? name;
      return h.viaTool('find_routes', { company }, undefined, 'find people at a company');
    }
  }

  // "what should I send Omar next", "what should I write to Lena": Orbit picks the kind from where the chat stands
  if (
    /^what (?:should|do|could) i (?:send|write|say to|message)\b|^what(?:'s| is) (?:the )?next (?:message|step) (?:for|to|with)\b/.test(
      lower,
    )
  )
    return withPerson((p) => h.viaTool('create_draft', { personId: p.id }, undefined, 'start a draft'));

  // "how should I prepare for my chat with Sofia", "what questions should I ask Ethan"
  if (
    /^(?:how (?:should|do|can) i (?:prep|prepare|get ready)|what (?:questions )?should i ask|what should i bring up)\b/.test(
      lower,
    )
  ) {
    const r = withPerson((p) =>
      h.viaTool('get_person', { personId: p.id, include: ['prep', 'facts'] }, undefined, 'prep for a chat'),
    );
    if (r) return r;
    if (ctx.nextChat && /\b(next|tomorrow|upcoming|my chat|my call)\b/.test(lower))
      return h.viaTool(
        'get_person',
        { personId: ctx.nextChat.personId, include: ['prep', 'facts'] },
        undefined,
        'prep',
      );
  }

  // "explain Priya's score", "why is Dan a weak tie": the score's reasons are on record
  {
    const m = lower.match(
      /^(?:explain|why is|why's|how come)\b.*\b(score|tie|closeness|weak|strong|close)\b/,
    );
    if (m) {
      const r = withPerson((p) =>
        h.viaTool('explain_score', { personId: p.id }, undefined, 'explain a score'),
      );
      if (r) return r;
    }
  }

  // "who should I check in with", "what follow-ups are due" (without an account: the quiet chats)
  if (
    /^(?:who should i (?:check in with|catch up with|reconnect with)|what follow-?ups are due|what(?:'s| is) due|what is orbit (?:about to|going to) send)$/.test(
      lower,
    )
  )
    return ctx.account
      ? h.viaTool('list_due', {}, undefined, 'list what is due')
      : h.viaTool('list_pipeline', { quietOnly: true }, undefined, 'list who went quiet');

  // "recommend who to talk to next"
  if (/^(?:recommend|suggest) (?:who|someone|people) (?:to )?(?:talk|reach out|write|meet)/.test(lower))
    return h.viaTool('list_recommendations', {}, undefined, 'list recommendations');

  // style: "make my drafts more formal", "use a direct tone", "switch to warm", "formal style please"
  {
    const m = lower.match(
      /^(?:make (?:my |all my )?(?:drafts|messages|emails|writing) (?:more |sound more |a bit more )?|use (?:a |the )?|switch (?:my tone )?to |go |be more |(?:a )?)(warm|warmer|direct|formal|casual|friendlier|friendly|professional)(?: tone| style| please| instead|er)*(?: please)?$/,
    );
    if (m) {
      const word = m[1]!;
      const tone = /formal|professional/.test(word) ? 'formal' : /direct/.test(word) ? 'direct' : 'warm';
      return h.viaTool(
        'update_settings',
        { section: 'style', tonePreset: tone },
        undefined,
        'change your tone',
      );
    }
  }

  // "shorter warm-ups please", "make warm-ups 3 days", "set the warm-up length to a week"
  {
    const m = lower.match(
      /\bwarm-?ups?\b.*?\b(\d+|a|one|two|three|four|five) (days?|weeks?)\b|^(shorter|longer) warm-?ups/,
    );
    if (m) {
      const n = m[3]
        ? m[3] === 'shorter'
          ? 2
          : 7
        : (Number(m[1]) ||
            ({ a: 1, one: 1, two: 2, three: 3, four: 4, five: 5 } as Record<string, number>)[m[1]!] ||
            3) * (m[2]!.startsWith('week') ? 7 : 1);
      return h.viaTool(
        'update_limits',
        { warmUpDays: Math.max(1, Math.min(14, n)) },
        undefined,
        'change the warm-up length',
      );
    }
  }

  // "I'm no longer targeting Bain", "drop Figma" (a target company)
  {
    const m = text.match(
      /^(?:i'?m no longer targeting|i am no longer targeting|stop targeting|remove|drop|delete|take)\s+(.+?)(?:\s+(?:from|off) (?:my )?(?:targets?|target list|target companies|list))?$/i,
    );
    const t = m && ctx.targets?.find((x) => x.name.toLowerCase() === m[1]!.trim().toLowerCase());
    if (t)
      return h.viaTool('delete_target_company', { targetId: t.id }, undefined, 'remove a target company');
    if (m && /\btarget/i.test(text) && !h.person(m[1]!).person)
      return {
        kind: 'text',
        text: `${m[1]!.trim()} is not one of your target companies, so there is nothing to remove.`,
      };
  }

  // "that score is wrong, we're close" (with a person), "she's a close friend"
  if (/\b(we'?re|we are) (?:really |very )?close\b/.test(lower)) {
    const r = withPerson((p) =>
      h.viaTool('rate_closeness', { personId: p.id, closeness: 5 }, undefined, 'rate closeness'),
    );
    if (r) return r;
  }

  // "rewrite my draft to Priya to be shorter", "shorten my draft to Lena"
  if (
    /\b(shorter|shorten|trim|tighten|more concise|too long)\b/.test(lower) &&
    /\b(draft|message|email|note)\b/.test(lower)
  ) {
    const m = who();
    const mine = (ctx.drafts ?? []).filter(
      (d) => d.status === 'draft' && (!m.person || d.personId === m.person.id),
    );
    if (mine.length === 1 && mine[0]!.body) {
      const short = shortenMessage(mine[0]!.body);
      if (short !== mine[0]!.body.trim())
        return h.viaTool(
          'update_draft_body',
          { draftId: mine[0]!.id, body: short },
          'Cut it down to the ask. Edit anything in the card.',
          'shorten a draft',
        );
    }
    if (mine.length > 1)
      return h.viaTool(
        'list_drafts',
        { list: 'to_send' },
        'Which draft? Open one, then say "make it shorter".',
        'list drafts',
      );
  }
  return undefined;
}

/** The rest of the inventory's phrases, after every other pattern. */
export function routeMore(
  text: string,
  lower: string,
  ctx: RouterContext,
  h: MoreHelpers,
): RouterIntent | undefined {
  const who = () => mentioned(text, ctx.people);
  const withPerson = (run: (p: MatchablePerson) => RouterIntent, ask?: string): RouterIntent | undefined => {
    const m = who();
    if (m.person) return run(m.person);
    if (m.candidates.length && m.name) return h.ambiguous(m.name, m.candidates);
    if (ask) return { kind: 'text', text: ask };
    return undefined;
  };
  const now = ctx.now ?? new Date();
  const draftsOf = (personId?: string, statuses = ['draft', 'failed']) =>
    (ctx.drafts ?? []).filter((d) => statuses.includes(d.status) && (!personId || d.personId === personId));
  const kindIn = findKindWord(lower, h);

  // ---- Today: the badge, the day, what can wait ----
  if (
    /^(?:how many (?:messages|drafts|things) (?:are )?(?:waiting|to send)(?: on me)?|what'?s the badge(?: count)?|anything to send|what do i (?:need|have) to send|what drafts do i have(?: to send)?)$/.test(
      lower,
    )
  )
    return h.viaTool('list_drafts', { list: 'to_send' }, undefined, 'list drafts');
  if (
    /^(?:run the daily update|did today get set up(?: yet)?|re-?check what i should do today|update today|refresh my day)$/.test(
      lower,
    )
  )
    return h.viaTool('refresh_brief', {}, undefined, 'refresh the brief');
  if (
    /^(?:show (?:me )?everything,? not just the top few|what else could i do today|show (?:me )?the cards that can wait|show (?:me )?more cards|what else is there today)$/.test(
      lower,
    )
  )
    return h.viaTool(
      'ensure_card_drafts',
      { scope: 'today_more' },
      undefined,
      'show the cards that can wait',
    );
  if (
    /^(?:show (?:me )?the drafts that can wait|what else is in drafts|show (?:me )?all pending drafts|drafts that can wait)$/.test(
      lower,
    )
  )
    return h.viaTool('list_drafts', { list: 'can_wait' }, undefined, 'list drafts');
  if (/^(?:show (?:me )?my sent messages|what (?:have i|did i) sen[dt]|sent messages)$/.test(lower))
    return h.viaTool('list_drafts', { list: 'sent' }, undefined, 'list sent messages');
  if (/^(?:what'?s snoozed|show (?:me )?(?:the )?snoozed(?: cards| drafts)?|snoozed)$/.test(lower))
    return h.viaTool('list_drafts', { list: 'snoozed' }, undefined, 'list snoozed cards');
  if (
    /^(?:continue the draft i started|go back to my unfinished draft|open the message i was writing|my unfinished drafts?|drafts i started)$/.test(
      lower,
    )
  )
    return h.viaTool('list_drafts', { list: 'started' }, undefined, 'list started drafts');

  // ---- someone wrote back: "Daniel replied to me", "Lena got back to me on LinkedIn" ----
  {
    const m = text.match(
      /^(?:yes,? )?(.+?) (?:did )?(?:replied|reply|responded|wrote back|got back to me|answered|emailed me back|messaged me back)(?: to me)?(?: on linkedin| by email| over email| today| yesterday)?$/i,
    );
    if (m && !/^(who|anyone|someone|nobody|everyone|they|he|she)$/i.test(m[1]!.trim())) {
      const r = h.person(m[1]!);
      if (r.person) {
        const card = ctx.cards?.find((c) => c.personId === r.person!.id && c.kind === 'confirm_stage');
        if (card)
          return h.viaTool(
            'answer_stage_question',
            { suggestionId: card.id, accept: true },
            undefined,
            'confirm a reply',
          );
        return h.viaTool(
          'move_pipeline_stage',
          { personId: r.person.id, stage: 'replied' },
          undefined,
          'move a chat',
        );
      }
      if (r.candidates.length) return h.ambiguous(m[1]!, r.candidates);
    }
  }

  // ---- a card's question: "confirm the stage change for Marcus", "no, keep the stage" ----
  if (
    /\b(stage change|did reply|that happened|keep the stage|nothing is booked|did not change|didn'?t change)\b/.test(
      lower,
    )
  ) {
    const yes = !/^(no|nope|nah)\b|keep the stage|not|didn'?t|nothing/.test(lower);
    const m = who();
    const cards = (ctx.cards ?? []).filter(
      (c) => c.kind === 'confirm_stage' && (!m.person || c.personId === m.person.id),
    );
    if (cards.length === 1)
      return h.viaTool(
        'answer_stage_question',
        { suggestionId: cards[0]!.id, accept: yes },
        undefined,
        'answer a card',
      );
    if (!cards.length && yes && m.person && /\b(did reply|replied)\b/.test(lower))
      return h.viaTool(
        'move_pipeline_stage',
        { personId: m.person.id, stage: 'replied' },
        undefined,
        'move a chat',
      );
    return h.viaTool(
      'get_today_brief',
      {},
      cards.length
        ? 'Which one? Answer it on its card here.'
        : 'There is no stage question open right now. Here is your day.',
      'show the brief',
    );
  }
  if (
    /\b(intro(?:duction)?|introduced)\b/.test(lower) &&
    (/^(yes|no|confirm|not an intro|that was|nobody introduced)/.test(lower) ||
      /^\S+(?: \S+)? introduced me to /.test(lower))
  ) {
    const yes = !/^no\b|not an intro|nobody/.test(lower);
    const cards = (ctx.cards ?? []).filter((c) => c.kind === 'confirm_intro');
    if (cards.length === 1)
      return h.viaTool(
        'answer_intro_question',
        { suggestionId: cards[0]!.id, yes },
        undefined,
        'answer a card',
      );
    return h.viaTool(
      'get_intro_web',
      {},
      cards.length
        ? 'Which one? Answer it on its card in Today.'
        : 'There is no intro question open right now. These are your introductions.',
      'list introductions',
    );
  }
  if (
    /\b(merge|same person|duplicate|combine (?:these|the) two|different people|keep them as two|don'?t merge)\b/.test(
      lower,
    )
  ) {
    const no = /different|keep them|don'?t|^no\b/.test(lower);
    const merges = ctx.merges ?? [];
    if (merges.length === 1)
      return h.viaTool(
        no ? 'reject_merge' : 'merge_people',
        { mergeId: merges[0]!.id },
        undefined,
        no ? 'keep two people' : 'merge two people',
      );
    return {
      kind: 'text',
      text: merges.length
        ? 'Which two? Open them on the People page, where each possible duplicate has Merge and Keep both.'
        : 'Orbit has no possible duplicates waiting right now.',
      href: '/people?view=list',
    };
  }

  // ---- promises: "I sent Priya my resume, mark the promise done" ----
  if (
    /\b(promise|action item|i kept|i sent .+ (?:my|the) (?:resume|deck|spec|portfolio|writing sample)|done with the intro i owed)\b/.test(
      lower,
    )
  ) {
    const m = who();
    const items = (ctx.actionItems ?? []).filter((a) => !m.person || a.personId === m.person.id);
    if (items.length === 1)
      return h.viaTool(
        'complete_action_item',
        { actionItemId: items[0]!.id },
        undefined,
        'mark a promise done',
      );
    if (m.person)
      return h.viaTool(
        'get_person',
        { personId: m.person.id, include: ['promises'] },
        items.length
          ? 'Which one? These are your open promises to them.'
          : `There is no open promise to ${firstOf(m.person)} on record.`,
        'open a person',
      );
    return h.viaTool(
      'get_today_brief',
      {},
      items.length
        ? 'Which promise? They are on the cards here.'
        : 'No open promises on record. Here is your day.',
      'show the brief',
    );
  }

  // ---- warm-ups: "start a warm-up for Noah", "mark today's warm-up step done", "skip this warm-up step" ----
  {
    const start = text.match(
      /^(?:start (?:a |the )?warm-?\s?up (?:for|with)|warm up|do the linkedin warm-?\s?up (?:for|with))\s+(.+?)(?: before .*| first)?$/i,
    );
    if (start) {
      const r = h.person(start[1]!);
      if (r.person)
        return h.viaTool(
          'create_draft',
          { personId: r.person.id, warmUp: 'start' },
          undefined,
          'start a warm-up',
        );
      if (r.candidates.length) return h.ambiguous(start[1]!, r.candidates);
      return h.nobody(start[1]!);
    }
    if (
      /\bwarm-?\s?up\b/.test(lower) &&
      /\b(done|did|liked|commented|reacted|skip|mark)\b/.test(lower) &&
      !/\b(link|where|open)\b/.test(lower)
    ) {
      const m = who();
      const w = (ctx.warmups ?? []).filter((x) => !m.person || x.personId === m.person.id);
      const skip = /\bskip|will not|won'?t\b/.test(lower);
      if (w.length === 1 && w[0]!.next)
        return h.viaTool(
          'mark_warmup_step',
          { chatId: w[0]!.chatId, actionId: w[0]!.next, done: !skip },
          undefined,
          'mark a warm-up step',
        );
      return h.viaTool(
        'get_today_brief',
        {},
        w.length
          ? 'Which warm-up? Each step is on its card here.'
          : 'No warm-up is in progress right now. Here is your day.',
        'show the brief',
      );
    }
    if (
      /\b(comment|react)\b.*\bpost\b|\blinkedin comment\b|\bwarm-?up step\b|^skip the (?:comment|view|follow|react) step$/.test(
        lower,
      )
    )
      return h.viaTool(
        'get_today_brief',
        {},
        "The warm-up steps and their LinkedIn links are on today's cards.",
        'show the brief',
      );
  }

  // ---- cards in Today: review, send, snooze, dismiss, restore, draft now ----
  {
    const verb = lower.match(
      /^(snooze|dismiss|remove|drop|restore|unsnooze|bring back|wake|undo that dismiss|not today)/,
    )?.[1];
    if (
      verb &&
      /\b(card|suggestion|follow-?up|check-?in|thank-?you|reconnect|referral|it|this|that)\b/.test(lower)
    ) {
      const m = who();
      const kindCard = (ctx.cards ?? []).filter(
        (c) => (!m.person || c.personId === m.person.id) && (!kindIn || cardMatchesKind(c.kind, kindIn)),
      );
      if (/^(restore|unsnooze|bring back|wake|undo that dismiss)/.test(verb))
        return h.viaTool(
          'list_drafts',
          { list: 'snoozed' },
          'These are your snoozed cards. Tap one to bring it back.',
          'list snoozed cards',
        );
      if (kindCard.length === 1) {
        const c = kindCard[0]!;
        if (verb === 'snooze' || verb === 'not today') {
          const d = lower.match(/(\d+) days?/);
          const days = /week/.test(lower) ? 7 : d ? Number(d[1]) : 1;
          return h.viaTool(
            'manage_suggestion',
            { suggestionId: c.id, action: 'snooze', days: Math.min(30, days) },
            undefined,
            'snooze a card',
          );
        }
        const reason = /already|sent it|did it/.test(lower)
          ? 'already_did'
          : /wrong person/.test(lower)
            ? 'wrong_person'
            : /bad|wrong draft/.test(lower)
              ? 'bad_draft'
              : 'not_now';
        return h.viaTool('dismiss_suggestion', { suggestionId: c.id, reason }, undefined, 'dismiss a card');
      }
      return h.viaTool(
        'get_today_brief',
        {},
        'Which card? Snooze or dismiss it right on its card here.',
        'show the brief',
      );
    }
  }
  if (/\bsnoozed\b/.test(lower) && /\b(bring|restore|unsnooze|wake|back)\b/.test(lower))
    return h.viaTool(
      'list_drafts',
      { list: 'snoozed' },
      'These are your snoozed cards. Tap one to bring it back.',
      'list snoozed cards',
    );
  if (/^(?:remind me about (?:this|it) in|push it to tomorrow|not today)/.test(lower))
    return h.viaTool(
      'get_today_brief',
      {},
      'Which card? Snooze it right on its card here.',
      'show the brief',
    );

  // ---- the note page: "open the note page for Omar" ----
  if (/\bnote page\b|^(?:i want to )?write notes (?:from|about|on|for)\b/.test(lower)) {
    const r = who();
    if (r.person && /^(?:i want to )?write notes/.test(lower))
      return {
        kind: 'text',
        text: `What should the note about ${firstOf(r.person)} say? Write it like: note about ${firstOf(r.person)}: she suggested the platform team.`,
        href: '/notes/new',
      };
    return h.viaTool(
      'open_page',
      { page: 'add_note', ...(r.person ? { personId: r.person.id } : {}) },
      undefined,
      'open the note page',
    );
  }

  // ---- drafts by what they are: "read me the thank-you draft", "the message to Omar", "the follow-up you drafted for Priya" ----
  if (/\b(draft|message|email|note|follow-?up|thank-?you|check-?in|subject)\b/.test(lower)) {
    const m = who();
    const open =
      /^(?:show|read|open|what does|what'?s in|let me see|see|continue|reopen|keep writing|paste me|copy|give me|is anything wrong|check|does|is this|what subject|why can'?t|am i allowed|where do i paste|remind me)/.test(
        lower,
      ) && !/\bnote page\b/.test(lower);
    const send = /^(?:send|approve|ship|ok,? send|retry|resend|try (?:that|it|the)?\b.*\bagain)/.test(lower);
    const discard = /^(?:discard|throw away|delete|drop|scrap|bin|trash|get rid of)/.test(lower);
    const edit = /^(?:change|make the subject|edit|set the subject)/.test(lower);
    if (open || send || discard || edit) {
      const statuses =
        send && /retry|again|resend/.test(lower)
          ? ['failed']
          : discard
            ? ['draft', 'failed']
            : ['draft', 'failed', 'handed_off'];
      let mine = draftsOf(m.person?.id, statuses);
      if (kindIn && mine.length > 1) mine = mine.filter((d) => d.kind === kindIn) as typeof mine;
      if (!m.person && kindIn)
        mine = draftsOf(undefined, statuses).filter((d) => d.kind === kindIn) as typeof mine;
      const d = mine.length === 1 ? mine[0]! : undefined;
      if (d) {
        if (send) return h.viaTool('send_draft', { draftId: d.id }, undefined, 'send a draft');
        if (discard) return h.viaTool('discard_draft', { draftId: d.id }, undefined, 'discard a draft');
        if (edit) {
          const subject = text.match(/subject (?:to |line to )?['"“]?([^'"”]+?)['"”]?$/i)?.[1];
          if (subject && /subject/.test(lower))
            return h.viaTool(
              'update_draft_body',
              { draftId: d.id, subject },
              undefined,
              'change the subject',
            );
          return h.viaTool(
            'get_draft',
            { draftId: d.id },
            'Edit it right in the card, then send it when it reads right.',
            'open a draft',
          );
        }
        return h.viaTool('get_draft', { draftId: d.id }, undefined, 'open a draft');
      }
      if (discard && m.person && !mine.length)
        return {
          kind: 'text',
          text: `There is no unsent draft to ${firstOf(m.person)}, so there is nothing to discard.`,
          href: `/people/${m.person.id}`,
        };
      if (send && /retry|again|resend/.test(lower) && !mine.length)
        return h.viaTool(
          'list_drafts',
          { list: 'all', ...(m.person ? { personId: m.person.id } : {}) },
          `Nothing${m.person ? ` to ${firstOf(m.person)}` : ''} failed to send, so there is nothing to retry. These are your drafts.`,
          'list drafts',
        );
      if (m.person && !mine.length && (send || open))
        return h.viaTool(
          'create_draft',
          { personId: m.person.id, ...(kindIn && kindIn !== 'outreach' ? { kind: kindIn } : {}) },
          `There is no draft to ${firstOf(m.person)} yet, so here is one to read first.`,
          'start a draft',
        );
      if (m.candidates.length && m.name && !m.person) return h.ambiguous(m.name, m.candidates);
      if (mine.length > 1 || (!m.person && (open || send || discard || edit)))
        return h.viaTool(
          'list_drafts',
          { list: send && /retry|again|resend/.test(lower) ? 'all' : 'to_send' },
          mine.length > 1 || draftsOf().length ? 'Which one? Open it here.' : undefined,
          'list drafts',
        );
    }
  }
  if (
    /^(?:undo,? don'?t send(?: that)?|cancel the send|stop the (?:email|message) to .+|undo (?:the )?send)$/.test(
      lower,
    )
  ) {
    const m = who();
    const queued = (ctx.drafts ?? []).filter(
      (d) => d.status === 'queued' && (!m.person || d.personId === m.person.id),
    );
    if (queued.length === 1)
      return h.viaTool('undo_send', { draftId: queued[0]!.id }, undefined, 'undo a send');
    return {
      kind: 'text',
      text: 'Nothing is waiting to go out, so there is nothing to stop. Every send needs your Approve first.',
      href: '/inbox',
    };
  }
  if (
    /\b(mail app didn'?t open|didn'?t send it|bring the draft back|reopen the draft|take back the sent mark|i didn'?t send it)\b/.test(
      lower,
    )
  ) {
    const m = who();
    const handed = (ctx.drafts ?? []).filter(
      (d) => d.status === 'handed_off' && (!m.person || d.personId === m.person.id),
    );
    if (handed.length === 1)
      return h.viaTool(
        'manage_draft',
        { draftId: handed[0]!.id, action: 'revert_handoff' },
        undefined,
        'bring a draft back',
      );
    return h.viaTool(
      'list_drafts',
      { list: 'all' },
      handed.length
        ? 'Which one? Open it here.'
        : 'No message is waiting on an "I sent it". These are your drafts.',
      'list drafts',
    );
  }
  if (/^(?:yes,? )?(?:that (?:email|message) went out|i sent it|it went out)$/.test(lower)) {
    const handed = (ctx.drafts ?? []).filter((d) => d.status === 'handed_off');
    if (handed.length === 1)
      return h.viaTool('confirm_handoff', { draftId: handed[0]!.id }, undefined, 'log a sent message');
    return { kind: 'text', text: 'Which one? Say who it went to, like: I sent the message to {name}.' };
  }
  {
    const m = text.match(
      /^mark (?:the |my )?(?:linkedin |email )?(?:note|message|email|draft) to (.+?) as sent$/i,
    );
    if (m) {
      const r = h.person(m[1]!);
      if (r.person) {
        const d = (ctx.drafts ?? []).find((x) => x.personId === r.person!.id && x.status === 'handed_off');
        if (d) return h.viaTool('confirm_handoff', { draftId: d.id }, undefined, 'log a sent message');
        return {
          kind: 'text',
          text: `Orbit is not waiting on a message to ${firstOf(r.person)}. If you sent something outside Orbit, move their chat instead, like: move ${firstOf(r.person)} to first message sent.`,
          href: `/people/${r.person.id}`,
        };
      }
      if (r.candidates.length) return h.ambiguous(m[1]!, r.candidates);
    }
  }
  if (
    /^(?:send (?:it|this|these) (?:on|by|via) (?:linkedin|email|gmail)|i'?ll send it from gmail myself|give me the text so i can paste it.*|copy the message(?: text)?(?: again)?|give me the text one more time|copy the subject line)$/.test(
      lower,
    )
  ) {
    const mine = draftsOf();
    if (mine.length === 1)
      return h.viaTool(
        'get_draft',
        { draftId: mine[0]!.id },
        'Copy it from the card, or send it from there.',
        'open a draft',
      );
    return h.viaTool(
      'list_drafts',
      { list: 'to_send' },
      'Which one? Open it here to copy or send it.',
      'list drafts',
    );
  }
  if (/\b(why-?them line|my update is|i'?m applying to|redraft|the line it needs)\b/.test(lower)) {
    const mine = draftsOf().filter(() => true);
    return h.viaTool(
      'list_drafts',
      { list: 'to_send' },
      mine.length ? 'Which draft is that for? Open it and add the line in the card.' : undefined,
      'list drafts',
    );
  }
  if (
    /^(?:close the editor and keep my edits|save what i changed and close|keep my version|go back to the suggested text|reset my edits|use orbit'?s version|undo my changes to the draft|put the text back how it was|revert my edits)$/.test(
      lower,
    )
  )
    return h.viaTool(
      'list_drafts',
      { list: 'started' },
      'Which draft? Open it here; the card keeps your edits, and Reset puts back the suggested text.',
      'list drafts',
    );
  if (
    /^(?:i will attach my resume|remind me the message mentions an attachment|does this draft say my resume is attached)$/.test(
      lower,
    )
  )
    return h.viaTool(
      'list_drafts',
      { list: 'to_send' },
      'Which draft? Open it here to check what it says about your resume.',
      'list drafts',
    );
  {
    const m = text.match(/^send (.+?)'s at (.+)$/i);
    if (m) {
      const r = h.person(m[1]!);
      const d = r.person ? draftsOf(r.person.id)[0] : undefined;
      const when = whenFrom(m[2]!, now);
      if (d && when?.at)
        return h.viaTool(
          'schedule_sends',
          { draftIds: [d.id], startAt: when.at.toISOString() },
          undefined,
          'schedule a send',
        );
      if (r.person && !d)
        return {
          kind: 'text',
          text: `There is no draft to ${firstOf(r.person)} yet. Say: write to ${firstOf(r.person)}.`,
        };
    }
  }

  // ---- write, message, email someone: "message Lena", "email Priya", "begin a draft for Omar", "start a message to X on LinkedIn" ----
  {
    const m = text.match(
      /^(?:message|email|e-mail|dm|text|ping|reach out to|contact|keep writing to|continue writing to|open a blank email to|begin (?:a )?(?:draft|message) (?:for|to)|start (?:writing|a message|a draft|the first message|a first message) (?:to|for)|draft (?:something|a message|a note) (?:to|for)|write (?:something )?(?:to|for))\s+(.+?)(?:\s+(?:on linkedin|by email|over email|from discover|from today|from the card|directly|myself|now))*$/i,
    );
    if (m && !/^(?:the person|this person|that person|them|her|him|someone|the new contact)/i.test(m[1]!)) {
      const r = h.person(m[1]!.replace(/\s+(?:about|for|with) .*$/i, ''));
      if (r.person) return h.viaTool('create_draft', { personId: r.person.id }, undefined, 'start a draft');
      if (r.candidates.length) return h.ambiguous(m[1]!, r.candidates);
    }
    if (/^(?:skip the intro and message|message .+ directly|write to .+ directly)/.test(lower)) {
      const r = withPerson((p) => h.viaTool('create_draft', { personId: p.id }, undefined, 'start a draft'));
      if (r) return r;
    }
    if (
      /^(?:write to the person on that first-message card|draft the first message from the card|write to the person i just added|draft something to the new contact)$/.test(
        lower,
      )
    )
      return h.viaTool(
        'get_today_brief',
        {},
        'Which person? Their first-message cards are here, each with Write.',
        'show the brief',
      );
    if (
      /^(?:draft that referral ask|prepare the reconnect message|write the check-in for .+|draft the .+ card)$/.test(
        lower,
      )
    ) {
      const m2 = who();
      const cards = (ctx.cards ?? []).filter(
        (c) => (!m2.person || c.personId === m2.person.id) && (!kindIn || cardMatchesKind(c.kind, kindIn)),
      );
      if (cards.length === 1)
        return h.viaTool('ensure_card_drafts', { cardIds: [cards[0]!.id] }, undefined, 'draft a card');
      if (m2.person)
        return h.viaTool(
          'create_draft',
          { personId: m2.person.id, ...(kindIn ? { kind: kindIn } : {}) },
          undefined,
          'start a draft',
        );
      return h.viaTool('ensure_card_drafts', { scope: 'drafts_later' }, undefined, 'draft the cards');
    }
  }

  // ---- intros through someone: "ask Lena to introduce me to Theo", "get me an intro to Stripe through Dan" ----
  {
    const m =
      text.match(
        /^(?:ask|have)\s+(.+?)\s+(?:to introduce me to|to intro me to|for an intro(?:duction)? to|to connect me (?:with|to))\s+(.+)$/i,
      ) ??
      text
        .match(/^(?:get me an intro(?:duction)? to|intro me to)\s+(.+?)\s+(?:through|via)\s+(.+)$/i)
        ?.slice(0, 3)
        .reverse();
    if (m) {
      const [via, to] =
        m[0]?.startsWith('get') || m[0]?.startsWith('intro') ? [m[1]!, m[2]!] : [m[1]!, m[2]!];
      const a = h.person(via);
      const b = h.person(to);
      if (a.person && b.person)
        return h.viaTool(
          'create_draft',
          { kind: 'intro_request', personId: a.person.id, targetPersonId: b.person.id },
          undefined,
          'draft an intro request',
        );
      if (a.person && !b.person && ctx.companies.some((c) => c.toLowerCase() === to.trim().toLowerCase()))
        return h.viaTool(
          'find_routes',
          { company: ctx.companies.find((c) => c.toLowerCase() === to.trim().toLowerCase()) },
          `Pick who at ${to.trim()} ${firstOf(a.person)} should introduce you to, then ask again.`,
          'find routes',
        );
      if (!a.person && a.candidates.length) return h.ambiguous(via, a.candidates);
      if (!b.person && b.candidates.length) return h.ambiguous(to, b.candidates);
    }
    if (
      /^(?:draft (?:the |an )?intro (?:request|ask) (?:through|via|from) .+|request an intro through route \d|write the intro ask for route \d|draft an intro request from the map)$/.test(
        lower,
      )
    )
      return {
        kind: 'text',
        text: 'Who should introduce you, and to whom? Say it like: ask {name} to introduce me to {name2}.',
      };
  }

  // ---- pipeline: stages said other ways ----
  {
    const m =
      text.match(
        /^(?:mark|move|set|put|change)\s+(?:my |the )?(?:chat|call|coffee chat)\s+(?:with\s+)?(.+?)\s+(?:as|to|into|in)\s+(.+)$/i,
      ) ??
      text.match(/^change\s+(.+?)'s stage to\s+(.+)$/i) ??
      text.match(/^put\s+(.+?)\s+back in(?:to)?\s+(.+)$/i);
    if (m) {
      const stage = h.findStage(m[2]!);
      const r = h.person(m[1]!);
      if (stage && r.person)
        return h.viaTool('move_pipeline_stage', { personId: r.person.id, stage }, undefined, 'move a chat');
      if (stage && r.candidates.length) return h.ambiguous(m[1]!, r.candidates);
    }
    const arch = text.match(/^archive (?:the |my )?(?:chat with )?(.+?)(?: chat)?$/i);
    if (arch) {
      const r = h.person(arch[1]!);
      if (r.person)
        return h.viaTool(
          'move_pipeline_stage',
          { personId: r.person.id, stage: 'archived' },
          undefined,
          'archive a chat',
        );
    }
    const done = text.match(
      /^(?:the chat with|my chat with|the call with)\s+(.+?)\s+happened|^complete (?:the |my )?(?:chat with )?(.+?)(?: chat)?$|^(?:mark|move)\s+(.+?)\s+(?:as )?done$/i,
    );
    if (done) {
      const name = done[1] ?? done[2] ?? done[3]!;
      const r = h.person(name);
      if (r.person)
        return h.viaTool(
          'move_pipeline_stage',
          { personId: r.person.id, stage: 'completed', confirmEarly: true },
          undefined,
          'mark a chat done',
        );
      if (r.candidates.length) return h.ambiguous(name, r.candidates);
    }
    if (
      /^(?:we already talked|we met (?:yesterday|today|this morning)|the chat happened(?: early)?|yes mark done|mark it done)/.test(
        lower,
      )
    )
      return { kind: 'text', text: 'Which chat? Say who it was with, like: the chat with {name} happened.' };
    if (/^(?:undo that move|undo the move|oops,? revert the stage|revert the stage|undo that)$/.test(lower))
      return {
        kind: 'text',
        text: 'Whose move? Say it like: undo the move for {name}.',
        href: '/people?view=board',
      };
    if (/^(?:set|change|update) the stage (?:for|of) .+|^move this chat/.test(lower)) {
      const r = withPerson((p) =>
        h.choose(`Where does the chat with ${firstOf(p)} stand?`, 'Pick a stage:', [
          { label: 'Replied', message: `Move ${p.displayName} to replied` },
          { label: 'Scheduled', message: `Move ${p.displayName} to scheduled` },
          { label: 'Done', message: `Move ${p.displayName} to completed` },
        ]),
      );
      if (r) return r;
      return { kind: 'text', text: 'Whose chat, and to which stage? Say it like: move {name} to scheduled.' };
    }
  }
  // the board: views, filters, sorting
  {
    const view = /\bas a table\b|\btable view\b/.test(lower)
      ? 'table'
      : /\bcompan(y|ies) view\b/.test(lower)
        ? 'companies'
        : /\bthe board\b|\bboard view\b/.test(lower)
          ? 'board'
          : undefined;
    if (view && /\b(show|switch|open|view)\b/.test(lower))
      return h.viaTool('list_pipeline', { view }, undefined, 'list the pipeline');
    if (
      /^(?:only|just) target companies$|^(?:show )?(?:chats at |people at )?(?:my )?target companies only$/.test(
        lower,
      )
    )
      return h.viaTool('list_pipeline', { targetsOnly: true }, undefined, 'list the pipeline');
    if (/^(?:include|show) (?:the )?closed chats$/.test(lower))
      return h.viaTool('list_pipeline', { includeClosed: true }, undefined, 'list the pipeline');
    const sort = lower.match(
      /^(?:sort|order)(?: the pipeline| my chats)? by (last reply|last sent|closeness|time in stage|stage|name)$/,
    );
    if (sort) {
      const sortBy = {
        'last reply': 'lastReply',
        'last sent': 'lastSent',
        closeness: 'closeness',
        'time in stage': 'inStage',
        stage: 'stage',
        name: 'person',
      }[sort[1]!]!;
      return h.viaTool('list_pipeline', { sortBy }, undefined, 'sort the pipeline');
    }
    const at = text.match(/^who do i have at (.+?) in (?:the|my) pipeline$/i);
    if (at) return h.viaTool('list_pipeline', { query: at[1]!.trim() }, undefined, 'list the pipeline');
    if (
      /^(?:open|what'?s|show)(?: the)? next(?: step)? for /.test(lower) ||
      /^what'?s next (?:for|with) /.test(lower)
    ) {
      const r = withPerson((p) => h.viaTool('get_person', { personId: p.id }, undefined, 'open a person'));
      if (r) return r;
    }
    if (/^take me to the card for this chat$/.test(lower))
      return h.viaTool('get_today_brief', {}, undefined, 'show the brief');
  }

  // ---- times: "my chat with Priya is Thursday at 2pm for 30 minutes", "move the Omar call to Friday 10am" ----
  if (
    /\b(chat|call|meeting|coffee)\b/.test(lower) &&
    /\b(is|to|at|for|time|book)\b/.test(lower) &&
    (whenFrom(text, now) || /\btime\b/.test(lower))
  ) {
    const r = who();
    const when = whenFrom(text, now);
    if (r.person && when?.at && !when.dayOnly)
      return h.viaTool(
        'schedule_chat',
        {
          personId: r.person.id,
          startAt: when.at.toISOString(),
          ...(minutesFrom(text) ? { minutes: minutesFrom(text) } : {}),
        },
        undefined,
        'set the chat time',
      );
    if (r.person)
      return {
        kind: 'text',
        text: `When is the chat with ${firstOf(r.person)}? Say a day and time, like: my chat with ${firstOf(r.person)} is Thursday at 2pm.`,
      };
    if (r.candidates.length && r.name) return h.ambiguous(r.name, r.candidates);
    if (/\b(set|change|update|book) the time\b|update when the chat is/.test(lower))
      return {
        kind: 'text',
        text: 'Whose chat, and when? Say it like: my chat with {name} is Thursday at 2pm.',
      };
  }
  if (
    /^(?:book|put|send the invite)\b/.test(lower) &&
    /\b(calendar|invite|tuesday|monday|wednesday|thursday|friday|at \d)\b/.test(lower)
  ) {
    const r = who();
    const when = whenFrom(text, now);
    if (r.person && when?.at && !when.dayOnly)
      return h.viaTool(
        'schedule_chat',
        { personId: r.person.id, startAt: when.at.toISOString() },
        undefined,
        'set the chat time',
      );
    if (ctx.account)
      return h.viaTool(
        'list_replies',
        { replyClass: 'scheduling' },
        'Pick the time on the reply, then confirm the booking there.',
        'list replies',
      );
    return {
      kind: 'text',
      text: r.person
        ? `When is the chat with ${firstOf(r.person)}? Say a day and time, like: my chat with ${firstOf(r.person)} is Thursday at 2pm.`
        : 'Whose chat, and when? Say it like: my chat with {name} is Thursday at 2pm.',
    };
  }

  // ---- people: add by hand, relationships, hide, unhide, summaries, facts, suggested names, LinkedIn and email ----
  {
    // "add Jordan Kim at Stripe, jordan@stripe.com", "add Priya Shah, analyst at Evercore", "put Lena Novak in my people"
    const email = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
    const rest = (email ? text.replace(email, ' ') : text)
      .replace(/[,;]\s*$/, '')
      .replace(/\s+,/g, ',')
      .trim();
    const m =
      rest.match(
        /^(?:add|put|create|log)\s+([\p{L}'-]+(?:\s+[\p{L}'-]+){0,2}?)(?:,\s*(.+?))?\s+(?:at|from)\s+([^,]+?)(?:,\s*)?(?:\s+(?:to|in|into|on)\s+(?:my\s+)?(?:people|pipeline|orbit|contacts|network))?$/iu,
      ) ??
      rest.match(
        /^(?:add|put|create|log)\s+([\p{L}'-]+(?:\s+[\p{L}'-]+){1,2}?)(?:,\s*(.+?))?(?:,\s*)?(?:\s+(?:to|in|into|on)\s+(?:my\s+)?(?:people|pipeline|orbit|contacts|network))?(?:\s+and file the note with (?:him|her|them))?$/iu,
      );
    const name = m?.[1]?.trim();
    const looksLikeName =
      !!name &&
      !/\b(note|person|someone|somebody|them|it|this|that|the|a|an|my|new|goal|target|tag|deadline)\b/i.test(
        name,
      );
    if (
      m &&
      looksLikeName &&
      (m[3] ||
        email ||
        /\b(people|pipeline|orbit|contacts|network)\b/i.test(text) ||
        /^[A-Z]/.test(name!.split(' ')[1] ?? ''))
    ) {
      const existing = h.person(name!);
      const sameCompany =
        !m[3] ||
        !existing.person?.currentOrganizationRaw ||
        existing.person.currentOrganizationRaw.toLowerCase() === m[3].trim().toLowerCase();
      if (
        existing.person &&
        existing.person.displayName.toLowerCase() === name!.toLowerCase() &&
        sameCompany &&
        !email
      )
        return h.viaTool(
          'get_person',
          { personId: existing.person.id },
          `${existing.person.displayName} is already in your people.`,
          'open a person',
        );
      if (existing.person && !m[3] && !email && /\b(people|pipeline|orbit|contacts)\b/i.test(text))
        return h.viaTool(
          'get_person',
          { personId: existing.person.id },
          `${existing.person.displayName} is already in your people.`,
          'open a person',
        );
      const roleAt = m[2]?.match(/^(.+?)\s+at\s+(.+)$/i);
      const proper = name!.replace(/(^|\s)\p{Ll}/gu, (c) => c.toUpperCase());
      const link = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w%-]+\/?/i)?.[0];
      if (!email && !link)
        return {
          kind: 'text',
          text: `What's ${proper}'s email or LinkedIn link? Orbit needs one to reach them. Add it like: add ${proper}${m[3] ? ` at ${m[3].trim()}` : ''}, ${proper.split(' ')[0]!.toLowerCase()}@example.com.`,
        };
      const input: Record<string, unknown> = { name: proper };
      if (link) input.linkedinUrl = link.startsWith('http') ? link : `https://${link}`;
      const company = m[3]?.trim() ?? roleAt?.[2]?.trim();
      const title = roleAt ? roleAt[1]!.trim() : m[2]?.trim();
      if (company) input.company = company;
      if (title) input.title = title;
      if (email) input.email = email;
      return h.viaTool('add_person', input, undefined, 'add a person');
    }
    if (
      /^(?:add (?:a )?new person(?: from the pipeline)?|they are not in orbit yet,? add them|add the person this note is about)$/.test(
        lower,
      )
    )
      return {
        kind: 'text',
        text: 'Who is it? Give me their name and where they work, like: add Jordan Lee at Figma.',
      };
  }
  {
    const rel: [RegExp, string][] = [
      [/\brecruiter\b/, 'recruiter'],
      [/\bmentor\b/, 'mentor'],
      [/\b(alum|alumni|alumnus|alumna)\b/, 'alumni'],
      [/\bprofessor\b/, 'professor'],
      [/\bfamily friend\b/, 'family_friend'],
      [/\b(colleague|coworker|co-worker)\b/, 'colleague'],
      [/\b(peer|classmate|friend from class)\b/, 'peer'],
    ];
    const hit = rel.find(([re]) => re.test(lower));
    if (hit && /^(?:mark|set|tag|make|label)\b|\bis (?:a|an|my)\b/.test(lower) && !/\bwho\b/.test(lower)) {
      const r = withPerson((p) =>
        h.viaTool(
          'update_person',
          { personId: p.id, relationshipType: hit[1] },
          undefined,
          'set a relationship',
        ),
      );
      if (r) return r;
    }
  }
  if (/^(?:unhide .+|show .+ again|bring .+ back(?: to (?:people|my lists))?|stop hiding .+)$/.test(lower)) {
    const m = text.match(
      /^(?:unhide|show|bring|stop hiding)\s+(.+?)(?:\s+again|\s+back(?: to (?:people|my lists))?)?$/i,
    );
    if (m) {
      const hidden = resolvePerson(
        (ctx.hidden ?? []).map((p) => ({ ...p, hiddenAt: undefined })),
        m[1]!.trim(),
      );
      if (hidden.person)
        return h.viaTool(
          'update_person',
          { personId: hidden.person.id, unhide: true },
          undefined,
          'show a person again',
        );
      const shown = h.person(m[1]!);
      if (shown.person)
        return h.viaTool(
          'get_person',
          { personId: shown.person.id },
          `${shown.person.displayName} is not hidden.`,
          'open a person',
        );
      return h.viaTool(
        'search_people',
        { query: m[1]!.trim(), filter: 'hidden' },
        undefined,
        'find a hidden person',
      );
    }
  }
  if (/^(?:take .+ off my lists|hide this person)$/.test(lower)) {
    const r = withPerson(
      (p) => h.viaTool('hide_person', { personId: p.id }, undefined, 'hide a person'),
      'Who should I hide? Say their name.',
    );
    if (r) return r;
  }
  if (
    /\b(summary|talking points|what you know about)\b/.test(lower) &&
    /^(?:refresh|update|rewrite|redo|rebuild)\b/.test(lower)
  ) {
    const r = withPerson((p) =>
      h.viaTool('update_person', { personId: p.id, refreshSummary: true }, undefined, 'refresh a summary'),
    );
    if (r) return r;
  }
  {
    const m = text.match(/^(?:note that|add a fact:?|fact:)\s+(.+)$/i);
    if (m) {
      const about = mentioned(m[1]!, ctx.people);
      if (about.person) {
        const body = m[1]!.trim();
        const type = /\badvice\b|\bsaid to\b|\bsuggest/i.test(body)
          ? 'advice'
          : /\boffer/i.test(body)
            ? 'offer'
            : /\bmarathon|hobby|loves|training|from\b/i.test(body)
              ? 'personal'
              : 'background';
        return h.viaTool(
          'manage_fact',
          { personId: about.person.id, action: 'add', type, text: body },
          undefined,
          'save a fact',
        );
      }
      if (about.candidates.length && about.name) return h.ambiguous(about.name, about.candidates);
    }
  }
  if (/\bfact\b|\bhometown\b/.test(lower) && /^(?:delete|remove|drop|that .+ is wrong)/.test(lower)) {
    const r = withPerson((p) =>
      h.viaTool(
        'get_person',
        { personId: p.id, include: ['facts'] },
        'Which fact? Delete it from their profile, under Facts.',
        'open a person',
      ),
    );
    if (r) return r;
    return {
      kind: 'text',
      text: 'Whose fact? Open them and delete it under Facts, or say: what do I know about {name}.',
    };
  }
  {
    const m = text.match(
      /^(.+?) (?:suggested|recommended|told me to (?:talk|reach out|speak) to|said i should (?:talk|reach out) to|pointed me to)\s+(?:i (?:talk|reach out|speak) to\s+)?(.+)$/i,
    );
    if (m && !/^(?:who|what|they|someone)$/i.test(m[1]!)) {
      const r = h.person(m[1]!);
      if (r.person) {
        return h.viaTool(
          'save_suggested_contacts',
          { personId: r.person.id, text: m[2]!.replace(/\b(?:his|her|their) colleague\s+/gi, '') },
          undefined,
          'save suggested names',
        );
      }
    }
    if (/^save the people .+ recommended$/.test(lower)) {
      const r = withPerson((p) =>
        h.viaTool(
          'get_person',
          { personId: p.id, include: ['notes'] },
          'Who did they suggest? Say it like: {name} suggested I talk to Tom Lee at {company}.',
          'open a person',
        ),
      );
      if (r) return r;
    }
  }
  if (
    /\b(linkedin|profile url|email address|email for)\b/.test(lower) &&
    /^(?:open|reopen|what'?s|give me|show|find|get)\b/.test(lower)
  ) {
    const r = withPerson((p) => h.viaTool('get_person', { personId: p.id }, undefined, 'open a person'));
    if (r) return r;
  }
  if (/\b(?:questions?|prep)\b/.test(lower) && /^(?:pick|keep|untick|tick|use|drop)\b/.test(lower)) {
    const r = withPerson((p) =>
      h.viaTool(
        'get_person',
        { personId: p.id, include: ['prep'] },
        'Pick the questions on their Prep tab; the ticked ones come with you to the chat.',
        'prep',
      ),
    );
    if (r) return r;
    if (ctx.nextChat)
      return h.viaTool(
        'get_person',
        { personId: ctx.nextChat.personId, include: ['prep'] },
        'Pick the questions on the Prep tab; the ticked ones come with you to the chat.',
        'prep',
      );
  }

  // ---- prep, in more words ----
  if (/\bprep\b|\bprepare\b|get ready\b/.test(lower)) {
    if (/\b(tomorrow|next|upcoming|today'?s?)\b|prep card|from today/.test(lower) && ctx.nextChat)
      return h.viaTool(
        'get_person',
        { personId: ctx.nextChat.personId, include: ['prep', 'facts'] },
        undefined,
        'prep for a chat',
      );
    const r = withPerson((p) =>
      h.viaTool('get_person', { personId: p.id, include: ['prep', 'facts'] }, undefined, 'prep for a chat'),
    );
    if (r) return r;
    if (!ctx.nextChat && /\b(tomorrow|next|upcoming)\b/.test(lower))
      return h.viaTool(
        'list_pipeline',
        { stage: 'scheduled' },
        'No chat is booked yet, so there is nothing to prep. These are the chats already scheduled.',
        'list scheduled chats',
      );
  }

  // ---- notes: save, match, the note page ----
  {
    const m = text.match(/^(?:log|save|record) that (?:i (?:talked|spoke|met) (?:to|with) )?(.+)$/i);
    if (m) {
      const about = mentioned(m[1]!, ctx.people);
      if (about.person)
        return h.viaTool(
          'add_note',
          { text: m[1]!.trim(), personId: about.person.id, source: 'manual' },
          undefined,
          'save a note',
        );
    }
    if (
      /^(?:save|add) (?:these |my )?notes (?:for|about|on) .+$/.test(lower) ||
      /^i want to write notes from my chat with .+$/.test(lower)
    ) {
      const r = withPerson(
        (p) =>
          ({
            kind: 'text',
            text: `What should the note about ${firstOf(p)} say? Write it like: note about ${firstOf(p)}: she suggested the platform team.`,
            href: '/notes/new',
          }) as RouterIntent,
      );
      if (r) return r;
    }
    if (
      /\bnote\b/.test(lower) &&
      /\b(was with|is about|is .+'s|file (?:that|the) note|unmatched note|wasn'?t with anyone|pick the person for the note)\b/.test(
        lower,
      )
    ) {
      const r = who();
      const notes = ctx.unmatchedNotes ?? [];
      if (notes.length === 1 && r.person)
        return h.viaTool(
          'rematch_note',
          { noteId: notes[0]!.id, personId: r.person.id },
          undefined,
          'file a note',
        );
      return h.viaTool(
        'list_notes',
        {},
        notes.length
          ? 'Which note? Pick the person on the note itself.'
          : 'Every note is filed with someone already. These are your notes.',
        'list notes',
      );
    }
    if (
      /^(?:who will this note be filed with|which .+ would this note go to|would orbit match this note to .+)$/.test(
        lower,
      )
    )
      return {
        kind: 'text',
        text: 'Paste the note and Orbit shows who it would go to before saving, on the note page.',
        href: '/notes/new',
      };
    if (
      /\bnotes?\b/.test(lower) &&
      /\b(file|upload|import|dictated|notetaker|typed|clear|start the note over|unsaved|yesterday|tuesday|this morning)\b/.test(
        lower,
      )
    )
      return h.viaTool('open_page', { page: 'add_note' }, undefined, 'open the note page');
  }

  // ---- the map, routes and companies ----
  {
    const company = (name: string) =>
      ctx.companies.find((c) => c.toLowerCase() === name.trim().toLowerCase()) ?? name.trim();
    if (
      /\bon the map\b/.test(lower) &&
      /\b(only|alumni|targets?|target companies|introductions|filter)\b/.test(lower)
    ) {
      const filter = /alumni/.test(lower)
        ? 'alumni'
        : /target/.test(lower)
          ? 'targets'
          : /introduction/.test(lower)
            ? 'introductions'
            : undefined;
      return h.viaTool(
        'open_page',
        { page: 'map', ...(filter ? { filter } : {}) },
        undefined,
        'open the map',
      );
    }
    const m =
      text.match(
        /^(?:open|show me|show|search the map for|tell me about|routes into|any former)\s+(?:the\s+)?(.+?)(?:\s+(?:company page|page|group|people)(?: on the map)?|\s+on the map|\s+in my network)+$/i,
      ) ??
      text.match(
        /^(?:show me the company view for|open the company page for|routes into|any former)\s+(.+?)(?: people)?(?: in my network)?$/i,
      ) ??
      text.match(/^open (?:the )?cluster of people at\s+(.+)$/i);
    if (m) {
      const name = m[1]!.replace(/^the\s+/i, '');
      const r = h.person(name);
      if (r.person) return h.viaTool('get_person', { personId: r.person.id }, undefined, 'open a person');
      return h.viaTool('find_routes', { company: company(name) }, undefined, 'open a company');
    }
    const hops = text.match(
      /^(?:what'?s the (?:warmest|best|shortest) (?:route|path|way) to|how many hops to|warm paths? to|best route to)\s+(.+)$/i,
    );
    if (hops) {
      const r = h.person(hops[1]!);
      if (r.person) return h.viaTool('find_routes', { personId: r.person.id }, undefined, 'find routes');
      if (r.candidates.length) return h.ambiguous(hops[1]!, r.candidates);
      return h.viaTool('find_routes', { company: company(hops[1]!) }, undefined, 'find routes');
    }
    const via = text.match(/^(?:see|show) how (.+?) can introduce me to (.+)$/i);
    if (via) {
      const r = h.person(via[2]!);
      if (r.person) return h.viaTool('find_routes', { personId: r.person.id }, undefined, 'find routes');
    }
    if (
      /\b(on the map|the map|reach mode|orbit view)\b/.test(lower) ||
      /^(?:(?:turn|rotate|spin) (?:the )?(?:map|orbit)|hover over|select|use the arrow keys|move to the next person|exit reach|stop looking for routes|back to the whole map|clear the (?:map|route)|reset the map)/.test(
        lower,
      )
    ) {
      const r = who();
      if (r.person && /\b(select|show|open|hover|card|dot|say)\b/.test(lower))
        return h.viaTool('get_person', { personId: r.person.id }, undefined, 'open a person');
      const filter = /alumni/.test(lower)
        ? 'alumni'
        : /target/.test(lower)
          ? 'targets'
          : /introduction/.test(lower)
            ? 'introductions'
            : undefined;
      if (/reach|route|intro on the map|look for routes/.test(lower) && !/exit|stop|back|clear/.test(lower))
        return h.viaTool('open_page', { page: 'reach' }, undefined, 'open reach');
      return h.viaTool(
        'open_page',
        { page: 'map', ...(filter ? { filter } : {}) },
        undefined,
        'open the map',
      );
    }
    if (
      /^(?:clear the route and filter|show route \d|the one through .+|the direct route|who are the other people in that group|show the \+\d+ at .+|open the selected dot)$/.test(
        lower,
      )
    ) {
      const at = text.match(/^show the \+\d+ at (.+)$/i);
      if (at) return h.viaTool('find_routes', { company: company(at[1]!) }, undefined, 'open a company');
      return h.viaTool('open_page', { page: 'map' }, undefined, 'open the map');
    }
    // the intro web
    if (
      /\b(intro(?:duction)?s?|intro web|intro story|chain)\b/.test(lower) &&
      /\b(web|chain|story|from|through|lead to|came from|at|which chats|light up|highlight)\b/.test(lower)
    ) {
      const r = who();
      const at = text.match(/\b(?:at|is at)\s+([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*)*)/);
      const q = r.person?.displayName ?? at?.[1];
      return h.viaTool('get_intro_web', q ? { query: q } : {}, undefined, 'list introductions');
    }
  }

  // ---- Discover ----
  if (
    /^(?:refresh discover|recompute who i should meet|any new recommendations|new recommendations|update my recommendations)$/.test(
      lower,
    )
  )
    return h.viaTool('manage_recommendation', { action: 'refresh' }, undefined, 'refresh recommendations');
  if (
    /\b(discover|recommendation|for later|bookmark|at the top of)\b/.test(lower) ||
    /^(?:dismiss|i already know|not now for)\b/.test(lower)
  ) {
    const r = who();
    const rec = r.person ? (ctx.recs ?? []).find((x) => x.personId === r.person!.id) : undefined;
    const save = /\b(save|bookmark|keep .+ at the top|for later)\b/.test(lower);
    const dismiss = /\b(dismiss|remove|not now|already know|wrong role|wrong company)\b/.test(lower);
    if (rec && (save || dismiss)) {
      const reason = /wrong role/.test(lower)
        ? 'wrong_role'
        : /wrong company/.test(lower)
          ? 'wrong_company'
          : /know/.test(lower)
            ? 'know_them'
            : 'not_now';
      return h.viaTool(
        'manage_recommendation',
        save
          ? { action: 'save', recommendationId: rec.id }
          : { action: 'dismiss', recommendationId: rec.id, reason },
        undefined,
        save ? 'save a recommendation' : 'dismiss a recommendation',
      );
    }
    if (r.person && /^(?:write|draft|start|message)\b/.test(lower))
      return h.viaTool('create_draft', { personId: r.person.id }, undefined, 'start a draft');
    if (save || dismiss)
      return h.viaTool(
        'list_recommendations',
        {},
        r.person
          ? `${firstOf(r.person)} is not on your Discover list right now. These are.`
          : 'Which one? Save or dismiss them right here.',
        'list recommendations',
      );
    if (/\b(intro route|find an intro|look for routes)\b/.test(lower))
      return h.viaTool('open_page', { page: 'reach' }, undefined, 'open reach');
  }

  // ---- integrations and setup ----
  if (
    /\b(connections\.csv|my connections)\b/.test(lower) &&
    !/linkedin/.test(lower) &&
    /\b(upload|import|here|add|use)\b/.test(lower)
  )
    return h.setupLinkedin("Sure. Drop your LinkedIn export here and I'll bring your connections in.");
  if (
    /^(?:sync google(?: again)?|reconnect google(?: and pull my email)?|google is not connected|pull new mail(?: and calendar)?|sync my (?:gmail|email|mail)|fix the google problem|resync gmail)$/.test(
      lower,
    )
  )
    return h.setupGmail(
      ctx.setup?.google
        ? 'Reconnect below and I will pull your new mail and meetings.'
        : "Gmail isn't connected yet. Connect it below and I'll keep your inbox in sync.",
    );
  if (
    /^(?:stop syncing my (?:email|gmail|mail)|revoke (?:gmail|google)(?: access)?|unlink (?:gmail|google))$/.test(
      lower,
    )
  )
    return h.viaTool('disconnect_google', {}, undefined, 'disconnect Google');
  if (/\b(client id|oauth client)\b/.test(lower))
    return {
      kind: 'text',
      text: 'The Google client id is under Settings, Integrations, next to Connect Google.',
      href: '/settings/integrations',
    };
  if (
    /^(?:what integration needs attention|open the integrations that need fixing|what'?s broken|is anything disconnected)$/.test(
      lower,
    )
  )
    return h.viaTool('get_settings', { section: 'integrations' }, undefined, 'show integrations');
  if (
    /^(?:don'?t use|uncheck|untick|ignore|hide) (?:the|that)? ?(?:line|facet)\b|^(?:uncheck|untick) the .+ facet$|^ignore that resume line$|^(?:fix|correct) (?:my role|the (?:employer|role|project)(?: description)?)\b|^the employer on that line\b/.test(
      lower,
    )
  )
    return h.viaTool(
      'get_settings',
      { section: 'profile' },
      'Tick or untick each line from your resume here, or fix it, under Settings, Profile.',
      'show the resume',
    );
  if (/\bresume\b/.test(lower)) {
    if (/^(?:upload|here'?s|replace|use|add|attach|update)\b|\bnew resume\b|this (?:file|pdf)/.test(lower))
      return h.setup('resume', 'Drop your resume here and I will read it.');
    if (/^(?:skip|not now|later)/.test(lower))
      return {
        kind: 'text',
        text: 'No problem. Add your resume any time from the + button or Settings, Profile.',
      };
    if (
      /\b(line|facet|employer|role|project|high school|treasurer|uncheck|ignore|don'?t use|fix|correct)\b/.test(
        lower,
      )
    )
      return h.viaTool(
        'get_settings',
        { section: 'profile' },
        'Tick or untick each line from your resume here, or fix it, under Settings, Profile.',
        'show the resume',
      );
    if (/^(?:what(?:'s| is| does)|show|read)\b/.test(lower))
      return h.viaTool('get_settings', { section: 'profile' }, undefined, 'show the resume');
  }
  if (/^(?:use this pdf|here'?s my resume|skip the resume for now)$/.test(lower))
    return /skip/.test(lower)
      ? { kind: 'text', text: 'No problem. Add your resume any time from the + button or Settings, Profile.' }
      : h.setup('resume', 'Drop your resume here and I will read it.');
  if (/\b(claude|anthropic|api key|sk-ant)\b/.test(lower)) {
    if (/\b(remove|delete|stop using|forget)\b/.test(lower))
      return h.viaTool('set_claude_key', {}, undefined, 'remove the Claude key');
    if (/\b(save|test|use|here'?s|add|set)\b/.test(lower))
      return h.setup('claude_key', 'Paste your Claude key here. It stays on this device.');
    const feature = /\bnotes?\b/.test(lower)
      ? 'notes'
      : /\b(email|mail|triage)\b/.test(lower)
        ? 'emailTriage'
        : /\bsummar/.test(lower)
          ? 'summaries'
          : /\bresume\b/.test(lower)
            ? 'resume'
            : /\bdrafts?\b/.test(lower)
              ? 'drafts'
              : undefined;
    const on = /\b(let|enable|turn on|allow|use)\b/.test(lower)
      ? true
      : /\b(turn off|disable|stop|don'?t)\b/.test(lower)
        ? false
        : undefined;
    if (feature && on !== undefined)
      return h.viaTool('set_llm_feature', { feature, on }, undefined, 'change what Claude may do');
    const cap = lower.match(/\bcap claude at (\d+) requests?\b/);
    if (cap)
      return h.viaTool(
        'update_limits',
        { llmDailyRequestCap: Number(cap[1]) },
        undefined,
        'set the Claude budget',
      );
  }
  if (/^(?:raise|lower|set) the (?:token|request) limit$/.test(lower))
    return h.viaTool(
      'get_usage',
      {},
      'Here is what Claude used today. Change the daily budget under Settings, Limits and schedule.',
      'show the Claude usage',
    );

  // ---- the chat itself ----
  {
    const reasoning = lower.match(
      /^(?:(show|hide)|turn (on|off)) (?:your |the |orbit'?s )?(?:reasoning|thinking(?: notes)?|thought process|gr[ae]y (?:notes|text|lines))(?: notes| lines)?$/,
    );
    if (reasoning) {
      const on = reasoning[1] === 'show' || reasoning[2] === 'on';
      return h.viaTool(
        'update_settings',
        { section: 'chat', showReasoning: on },
        undefined,
        on ? 'show the reasoning' : 'hide the reasoning',
      );
    }
  }

  // ---- profile, goals, targets ----
  {
    const school = text.match(/^(?:change|set|update) my school to (.+)$/i);
    if (school)
      return h.viaTool(
        'update_settings',
        { section: 'profile', school: school[1]!.trim() },
        undefined,
        'change your profile',
      );
    const year = lower.match(/^(?:set|change) my graduation year to (\d{4})$|^i graduate in (\d{4})$/);
    if (year)
      return h.viaTool(
        'update_settings',
        { section: 'profile', graduationYear: Number(year[1] ?? year[2]) },
        undefined,
        'change your profile',
      );
    const tz = lower.match(/^my time ?zone is (pacific|eastern|central|mountain)$/);
    if (tz) {
      const zone = {
        pacific: 'America/Los_Angeles',
        eastern: 'America/New_York',
        central: 'America/Chicago',
        mountain: 'America/Denver',
      }[tz[1]!]!;
      return h.viaTool(
        'update_settings',
        { section: 'profile', timezone: zone },
        undefined,
        'change your profile',
      );
    }
    const domain = lower.match(/^my school domain is ([\w.-]+\.\w+)$/);
    if (domain)
      return h.viaTool(
        'update_settings',
        { section: 'profile', schoolDomain: domain[1] },
        undefined,
        'change your profile',
      );
    const cycle = text.match(/^my (?:recruiting )?cycle is (.+)$/i);
    if (cycle)
      return h.viaTool(
        'update_settings',
        { section: 'goals', cycleLabel: cycle[1]!.trim() },
        undefined,
        'change your goals',
      );
    const loc = text.match(/^add (.+?) to my target locations$/i);
    if (loc)
      return h.viaTool(
        'update_settings',
        { section: 'goals', targetLocations: [loc[1]!.trim()] },
        undefined,
        'change your goals',
      );
    const recruiting = text.match(/^i'?m (?:recruiting|going) for (.+?)(?: internships?| roles?| jobs?)?$/i);
    if (recruiting) {
      const fns = recruiting[1]!
        .split(/,\s*|\s+and\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      return h.viaTool(
        'update_settings',
        { section: 'goals', targetFunctions: fns },
        undefined,
        'change your goals',
      );
    }
    if (/^(?:set up my profile|i'?m .+, .+@.+)$/.test(lower))
      return h.viaTool('open_page', { page: 'settings_profile' }, undefined, 'open your profile');
  }
  {
    const tc = (name: string) => ctx.targets?.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
    const add = text.match(/^(?:target|put)\s+(.+?)(?:\s+on my (?:list|target list|targets))?$/i);
    if (add && /^target\b|on my (?:list|target)/i.test(text) && !h.person(add[1]!).person)
      return h.viaTool(
        'manage_target_company',
        { action: 'add', names: add[1]!.trim() },
        undefined,
        'add a target company',
      );
    const prio = text.match(
      /^(?:make|set|mark)\s+(.+?)\s+(?:as |to )?(?:a )?(top|high|normal|medium|low) priority$|^(.+?) is (?:a )?(top|high|normal|medium|low) priority(?: now)?$|^add (.+?) as a (top|high|low) priority$/i,
    );
    if (prio) {
      const name = (prio[1] ?? prio[3] ?? prio[5])!;
      const level = (prio[2] ?? prio[4] ?? prio[6])!.toLowerCase();
      const priority = level === 'top' || level === 'high' ? 1 : level === 'low' ? 3 : 2;
      const t = tc(name);
      if (t)
        return h.viaTool(
          'manage_target_company',
          { action: 'set_priority', targetId: t.id, priority },
          undefined,
          'set a priority',
        );
      return h.viaTool(
        'manage_target_company',
        { action: 'add', names: name.trim() },
        `${name.trim()} was not a target yet, so it is one now. Set its priority from the list.`,
        'add a target company',
      );
    }
    const status = text.match(
      /^i (applied|am interviewing|'m interviewing|got an offer)(?: to| at| from)\s+(.+)$/i,
    );
    if (status) {
      const s = /applied/.test(status[1]!)
        ? 'applied'
        : /interview/.test(status[1]!)
          ? 'interviewing'
          : 'offer';
      const t =
        tc(status[2]!) ??
        ctx.targets?.find((x) => x.name.toLowerCase().startsWith(status[2]!.trim().toLowerCase()));
      if (t)
        return h.viaTool(
          'manage_target_company',
          { action: 'set_status', targetId: t.id, status: s },
          undefined,
          'update a target',
        );
      return h.viaTool(
        'manage_target_company',
        { action: 'add', names: status[2]!.trim() },
        `Added ${status[2]!.trim()} to your targets. Set its status there.`,
        'add a target company',
      );
    }
    const dl = text.match(
      /^(.+?)'s deadline is (.+)$|^set the (.+?) deadline to (.+)$|^remove the deadline for (.+)$/i,
    );
    if (dl) {
      const name = (dl[1] ?? dl[3] ?? dl[5])!;
      const when = dl[2] ?? dl[4];
      const t = tc(name);
      const date = when ? whenFrom(when, now)?.at : undefined;
      if (t && (date || dl[5]))
        return h.viaTool(
          'manage_target_company',
          { action: 'set_deadline', targetId: t.id, deadline: date ? date.toISOString().slice(0, 10) : '' },
          undefined,
          'set a deadline',
        );
      if (!t)
        return {
          kind: 'text',
          text: `${name.trim()} is not one of your target companies. Add it first: add ${name.trim()} to my target companies.`,
        };
    }
  }
  if (/^(?:have i hit|did i hit|am i over) my (?:daily |sending )?(?:limit|cap)$/.test(lower))
    return h.viaTool('get_settings', { section: 'limits' }, undefined, 'show your limits');
  if (/^which companies am i targeting$|^(?:show )?my target companies$/.test(lower))
    return h.viaTool('get_settings', { section: 'goals' }, undefined, 'show your targets');
  if (/^what'?s my weekly target$|^what tone do my drafts use$|^what are my (?:limits|settings)$/.test(lower))
    return h.viaTool(
      'get_settings',
      { section: /tone/.test(lower) ? 'style' : /target|limit/.test(lower) ? 'limits' : 'all' },
      undefined,
      'show settings',
    );

  // ---- style ----
  if (
    /^(?:learn my writing style from my emails|match how i actually write|rebuild my style card|learn from my sent mail)$/.test(
      lower,
    )
  )
    return h.viaTool(
      'update_settings',
      { section: 'style', learnFromSentMail: true },
      undefined,
      'learn your style',
    );
  if (/^(?:forget the learned style|go back to the preset tone|drop the style card)$/.test(lower))
    return h.viaTool(
      'update_settings',
      { section: 'style', forgetLearnedStyle: true },
      undefined,
      'drop the learned style',
    );
  {
    const link = text.match(/\b(https?:\/\/\S+)/);
    if (/\b(calendly|booking link|scheduling link|cal\.com)\b/i.test(lower)) {
      if (link)
        return h.viaTool(
          'update_settings',
          { section: 'schedule', schedulingLink: link[1] },
          undefined,
          'save your scheduling link',
        );
      if (/\bremove|delete|clear\b/.test(lower))
        return h.viaTool(
          'update_settings',
          { section: 'schedule', schedulingLink: '' },
          undefined,
          'remove your scheduling link',
        );
      return {
        kind: 'text',
        text: 'What is the link? Paste it like: my Calendly is https://calendly.com/you/20min.',
      };
    }
  }

  // ---- limits ----
  {
    const n = (s?: string) =>
      s ? Number(s) || { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }[s] || undefined : undefined;
    const weekly = lower.match(
      /^(?:set my weekly (?:goal|target) to|aim for) (\d+|one|two|three|four|five|six)(?: first messages| a week| per week)?(?: a week)?$/,
    );
    if (weekly)
      return h.viaTool('update_limits', { weeklyOutreachTarget: n(weekly[1]) }, undefined, 'change a limit');
    if (/^(?:raise|lower|increase|decrease) my (?:weekly )?target$/.test(lower))
      return h.viaTool(
        'get_settings',
        { section: 'limits' },
        'Your limits are here. Say the number, like: set my weekly target to 6.',
        'show your limits',
      );
    const cool = lower.match(/^(?:wait|set the cooldown to) (\d+) (hours?|days?)(?: between messages)?$/);
    if (cool)
      return h.viaTool(
        'update_limits',
        { perPersonCooldownHours: Number(cool[1]) * (cool[2]!.startsWith('day') ? 24 : 1) },
        undefined,
        'change a limit',
      );
    const cap = lower.match(/^(?:cap me at|allow) (\d+) (emails|linkedin messages|messages) a day$/);
    if (cap)
      return h.viaTool(
        'update_limits',
        /linkedin/.test(cap[2]!)
          ? { dailySendCapLinkedin: Number(cap[1]) }
          : { dailySendCapGmail: Number(cap[1]) },
        undefined,
        'change a limit',
      );
    const bumps = lower.match(
      /^(?:only one follow-?up|allow (one|two|three|\d) (?:bumps|follow-?ups)|no follow-?ups)$/,
    );
    if (bumps)
      return h.viaTool(
        'update_limits',
        { maxBumps: /^no/.test(lower) ? 0 : /only one/.test(lower) ? 1 : n(bumps[1]) },
        undefined,
        'change a limit',
      );
    if (/^(?:raise|lower) the (?:email|daily) limit$|^lower the cooldown$/.test(lower))
      return h.viaTool(
        'get_settings',
        { section: 'limits' },
        'Your limits are here. Say the number, like: cap me at 10 emails a day.',
        'show your limits',
      );
    if (/^(?:turn off|stop suggesting|disable|no more) (?:linkedin )?warm-?ups$/.test(lower))
      return h.viaTool('update_limits', { warmUpEnabled: false }, undefined, 'turn warm-ups off');
    if (/^(?:enable|turn on|start suggesting) (?:linkedin )?warm-?ups?$/.test(lower))
      return h.viaTool('update_limits', { warmUpEnabled: true }, undefined, 'turn warm-ups on');
  }
  if (/\b(hint|tip)\b/.test(lower) && /\b(hide|stop showing|dismiss|close|got it)\b/.test(lower)) {
    const hintId = /\bboard|pipeline\b/.test(lower) ? 'pipeline' : 'today';
    return h.viaTool('update_settings', { section: 'hints', hintId }, undefined, 'close a hint');
  }
  if (/^got it,? dismiss$/.test(lower))
    return h.viaTool('update_settings', { section: 'hints', hintId: 'today' }, undefined, 'close a hint');

  // ---- privacy and the account ----
  if (/^(?:download a backup|give me everything orbit stores|export everything)$/.test(lower))
    return h.viaTool('export_data', {}, undefined, 'export your data');
  if (/^(?:wipe orbit from this browser|delete orbit|erase everything)$/.test(lower))
    return h.viaTool('delete_all_data', {}, undefined, 'delete your data');
  if (/^(?:sign me out|log out(?: of orbit)?|end my session|sign out)$/.test(lower))
    return {
      kind: 'text',
      text: 'Sign out is under Settings, Data and privacy. In local mode your data lives in this browser; signing out does not delete it.',
      href: '/settings/privacy',
    };
  {
    const m = lower.match(
      /^(?:open|show|take me to) (?:the )?(goals|privacy|profile|integrations|limits|style|writing style) (?:settings|section)$|^(?:open|show) the (goals|privacy|profile|integrations|limits|style) settings$/,
    );
    const sec = m?.[1] ?? m?.[2];
    if (sec)
      return h.viaTool(
        'open_page',
        { page: `settings_${sec === 'writing style' ? 'style' : sec}` },
        undefined,
        'open settings',
      );
  }

  // ---- setup and the demo ----
  if (/^(?:finish setup|complete onboarding|i'?m done,? take me to today|i'?m done with setup)$/.test(lower))
    return h.viaTool('advance_onboarding', { finish: true }, undefined, 'finish setup');
  if (/^(?:next step|go back|skip this|continue my setup|get started)$/.test(lower))
    return h.viaTool('open_page', { page: 'landing' }, undefined, 'open setup');
  if (/^skip (?:google|gmail|linkedin)(?: for now)?$/.test(lower))
    return {
      kind: 'text',
      text: 'No problem. Connect it any time under Settings, Integrations.',
      href: '/settings/integrations',
    };
  if (/^(?:upload my connections|import this linkedin zip)$/.test(lower))
    return h.setupLinkedin("Sure. Drop your LinkedIn export here and I'll bring your connections in.");
  if (/^(?:connect google|connect gmail)$/.test(lower))
    return h.setupGmail(
      "Here's Gmail and Calendar. Once it's connected I can see who you email and send what you approve.",
    );
  if (
    /^(?:keep exploring the demo|stay in the demo|dismiss the demo note|back to the demo|go back to the sample student|open the demo again|open orbit)$/.test(
      lower,
    )
  )
    return h.viaTool('get_today_brief', {}, undefined, 'show the brief');
  if (/^leave the demo and start my own$/.test(lower))
    return h.viaTool('leave_demo', {}, undefined, 'leave the demo');

  // ---- the networking agent's goals and memory, said other ways ----
  if (
    /^(?:i want to find|help me find|looking for) (?:some )?(customers|investors|clients|candidates|a cofounder|mentors)\b/.test(
      lower,
    )
  ) {
    const what = lower.match(/(customers|investors|clients|candidates|a cofounder|mentors)/)![1]!;
    const kind = /customer|client/.test(what)
      ? 'sales'
      : /investor/.test(what)
        ? 'fundraising'
        : /candidate/.test(what)
          ? 'hiring'
          : /cofounder/.test(what)
            ? 'cofounder'
            : 'advice';
    return h.viaTool('set_goal', { kind, title: text.slice(0, 60) }, undefined, 'track a goal');
  }
  if (/^(?:yes,? )?track that(?: as a goal)?$/.test(lower))
    return { kind: 'text', text: 'Which goal? Say it like: track a goal of landing a PM internship.' };
  {
    const m = text.match(/^add (.+?) to my (recruiting|fundraising|sales|hiring) goal$/i);
    const g = m ? ctx.goals?.find((x) => x.kind === m[2]!.toLowerCase()) : undefined;
    if (m && g)
      return h.viaTool(
        'update_goal',
        { goalId: g.id, organizations: [m[1]!.trim()] },
        undefined,
        'change a goal',
      );
    if (m)
      return h.viaTool('list_goals', {}, `No ${m[2]} goal is active. These are your goals.`, 'list goals');
    const due = lower.match(/^move my deadline to (.+)$/);
    if (due && ctx.goals?.length === 1) {
      const d = whenFrom(due[1]!, now)?.at;
      if (d)
        return h.viaTool(
          'update_goal',
          { goalId: ctx.goals[0]!.id, dueAt: d.toISOString().slice(0, 10) },
          undefined,
          'change a goal',
        );
    }
    if (due) return h.viaTool('list_goals', {}, 'Which goal? These are yours.', 'list goals');
  }
  if (
    /^(?:look up .+ (?:before|first)|what is .+ up to(?: lately)?|what'?s .+ up to(?: lately)?|find out (?:about|more about) )/.test(
      lower,
    )
  ) {
    const r = withPerson((p) =>
      h.viaTool('research_person', { personId: p.id }, undefined, 'research a person'),
    );
    if (r) return r;
  }
  if (/^(?:what did you find on|any openers for)\b/.test(lower)) {
    const r = withPerson((p) => h.viaTool('get_dossier', { personId: p.id }, undefined, 'read research'));
    if (r) return r;
  }
  if (
    /^(?:find|search for) (?:heads? of|vps? of|founders? of|people (?:at|in|working on)|engineers at|pms at)\b/.test(
      lower,
    )
  )
    return h.viaTool(
      'find_people',
      { purpose: 'advice', query: text.replace(/^(?:find|search for) /i, '') },
      undefined,
      'find people',
    );
  if (
    /^(?:add|put) (?:them|those|the first (?:one|two|three|few)|.+ from that list)(?: in(?:to)? my pipeline| to (?:my )?people)?$/.test(
      lower,
    )
  )
    return {
      kind: 'text',
      text: 'Pick who to add on Discover, under Find people: each result has an Add button.',
      href: '/discover?tab=find',
    };
  if (/^(?:any replies i need to answer|show the replies picking a time|who replied to me)$/.test(lower))
    return ctx.account
      ? h.viaTool(
          'list_replies',
          /picking a time/.test(lower) ? { replyClass: 'scheduling' } : {},
          undefined,
          'list replies',
        )
      : h.viaTool('list_pipeline', { stage: 'replied' }, undefined, 'list replies');
  if (/^(?:draft a reply to|reply offering some times|answer .+'s question)/.test(lower)) {
    const r = who();
    if (r.person)
      return h.viaTool(
        'create_draft',
        { personId: r.person.id, kind: /times/.test(lower) ? 'schedule' : 'reply' },
        undefined,
        'draft a reply',
      );
    return ctx.account
      ? h.viaTool('list_replies', {}, undefined, 'list replies')
      : h.viaTool(
          'list_pipeline',
          { stage: 'replied' },
          'Who is it to? These are the people who replied.',
          'list replies',
        );
  }
  {
    const m = text.match(
      /^(?:pause (?:my )?outreach until after|i'?m (?:on vacation|away|traveling|busy) until)\s+(.+)$/i,
    );
    if (m) {
      const d = whenFrom(m[1]!, now)?.at ?? dayOfMonth(m[1]!, now);
      if (d)
        return h.viaTool(
          'pause_outreach',
          { until: d.toISOString().slice(0, 10) },
          undefined,
          'pause outreach',
        );
      return { kind: 'text', text: 'Until when? Say a date, like "pause outreach until Dec 20".' };
    }
  }
  if (/^(?:that score is wrong|the score is off)/.test(lower)) {
    const r = withPerson(
      (p) =>
        h.choose(`How close are you and ${firstOf(p)}?`, 'Pick one:', [
          { label: 'Close', message: `${p.displayName} is a close friend` },
          { label: 'Barely know them', message: `I barely know ${p.displayName}` },
        ]),
      'Whose score? Say it like: I barely know {name2}, or {name} is a close friend.',
    );
    if (r) return r;
  }

  return undefined;
}

/** "Oct 20", "the 20th": a date this month or next. */
function dayOfMonth(text: string, now: Date): Date | undefined {
  const m = text.match(/\bthe (\d{1,2})(?:st|nd|rd|th)\b/i);
  if (!m) return undefined;
  const d = new Date(now.getFullYear(), now.getMonth(), Number(m[1]));
  if (d.getTime() < now.getTime()) d.setMonth(d.getMonth() + 1);
  return d;
}

/** The kind of message or card a sentence names ("the thank-you", "the follow-up", "the reconnect"). */
function findKindWord(lower: string, h: MoreHelpers): MessageKind | undefined {
  if (/\breconnect\b/.test(lower)) return 'nurture';
  if (/\bfollow-?up\b/.test(lower)) return 'bump';
  if (/\bthank-?you\b/.test(lower)) return 'thank_you';
  if (/\bcheck-?in\b/.test(lower)) return 'nurture';
  if (/\breferral\b/.test(lower)) return 'referral_ask';
  if (/\bscheduling\b/.test(lower)) return 'schedule';
  if (/\breply\b/.test(lower)) return 'reply';
  const k = h.findKind(lower);
  return k === 'outreach' ? undefined : k;
}

/** A card kind against a message kind: "the follow-up card" is a follow_up_bump card. */
function cardMatchesKind(cardKind: string, kind: MessageKind): boolean {
  const map: Record<string, string[]> = {
    bump: ['follow_up_bump'],
    thank_you: ['thank_you'],
    nurture: ['nurture_checkin', 'reconnect'],
    referral_ask: ['ask_referral'],
    schedule: ['schedule_propose', 'schedule_confirm'],
    reply: ['reply_needed'],
    outreach: ['new_outreach'],
  };
  return (map[kind] ?? []).includes(cardKind);
}
