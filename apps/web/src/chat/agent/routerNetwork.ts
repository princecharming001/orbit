import type { GoalKind } from '@orbit/core';
import type { MatchablePerson } from './people-match';
import type { RouterIntent } from './router';

/**
 * The no-key router's phrases for the networking agent's tools (plan 16): goals, the tie score, research, finding
 * people, introductions, replies, autonomy, memory, a pause and what is due. Patterns only: anything that needs an
 * id the student cannot say (a search result, a reply, a route) goes to the list that shows them.
 */
export interface NetworkHelpers {
  viaTool: (tool: string, input: Record<string, unknown>, lead?: string, what?: string) => RouterIntent;
  person: (name: string) => { person?: MatchablePerson; candidates: MatchablePerson[] };
  nobody: (name: string) => RouterIntent;
  ambiguous: (name: string, candidates: MatchablePerson[]) => RouterIntent;
  goals: { id: string; kind: GoalKind; title: string }[];
  /** routes found in this tab (account mode), for "ask Sam to introduce me to Priya" */
  paths: { id: string; firstHopName: string; targetId?: string }[];
  /** signed in to an Orbit account: "who replied" and "what's due" mean the server's lists, not the board */
  account: boolean;
}

/** Words that say what a goal or a search is for. */
const KIND_WORDS: [RegExp, GoalKind][] = [
  [/\b(rais(e|ing)|fundrais\w*|investors?|vcs?|angels?|pre-?seed|seed round|series [a-c])\b/i, 'fundraising'],
  [/\b(customers?|clients?|sell(ing)?|sales|buyers?|leads?|pilots?)\b/i, 'sales'],
  [/\b(hir(e|ing)|candidates?|engineers? to hire|recruit (an?|some) )/i, 'hiring'],
  [/\b(co-?founders?)\b/i, 'cofounder'],
  [/\b(collaborat\w*|researchers?|papers?|lab|professors?|phd)\b/i, 'collaboration'],
  [/\b(mentors?|advice|advisors?|alumni)\b/i, 'advice'],
  [/\b(community|meetups?|events?|club)\b/i, 'community'],
  [/\b(intern(ship)?s?|jobs?|recruiting|offers?|full[- ]time|new grad|role)\b/i, 'recruiting'],
];

export function kindFrom(text: string): GoalKind | undefined {
  return KIND_WORDS.find(([re]) => re.test(text))?.[1];
}

const GOAL_KIND_WORD: Record<string, GoalKind> = {
  recruiting: 'recruiting',
  job: 'recruiting',
  internship: 'recruiting',
  fundraising: 'fundraising',
  fundraise: 'fundraising',
  sales: 'sales',
  hiring: 'hiring',
  advice: 'advice',
  cofounder: 'cofounder',
  'co-founder': 'cofounder',
  community: 'community',
  collaboration: 'collaboration',
  research: 'collaboration',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "2026-12-20", "Dec 20", "december 20th": YYYY-MM-DD (this year, or next if the date has passed). */
export function dateFrom(text: string, now = new Date()): string | undefined {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return iso[0];
  const m = /\b([a-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?\b/i.exec(text);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  if (month < 0) return undefined;
  const day = Number(m[2]);
  let y = now.getFullYear();
  const candidate = new Date(Date.UTC(y, month, day));
  if (candidate.getTime() < Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) y++;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}-${p(month + 1)}-${p(day)}`;
}

/** The search purpose behind "find me seed investors in climate". */
const FIND_WHO =
  /^find (?:me )?(?:some |a few |more |new )?((?:seed |angel |climate |fintech )?(?:investors?|vcs?|angels?|customers?|clients?|candidates?|engineers? to hire|mentors?|advisors?|alumni|a co-?founder|co-?founders?|collaborators?|researchers?|professors?))\b(.*)$/i;

export function routeNetwork(text: string, lower: string, h: NetworkHelpers): RouterIntent | undefined {
  const goalNamed = (word: string) => {
    const kind = GOAL_KIND_WORD[word.toLowerCase()];
    return (
      h.goals.find((g) => g.kind === kind) ??
      h.goals.find((g) => g.title.toLowerCase().includes(word.toLowerCase()))
    );
  };
  const withPerson = (name: string, run: (id: string) => RouterIntent): RouterIntent => {
    const r = h.person(name);
    if (r.person) return run(r.person.id);
    if (r.candidates.length) return h.ambiguous(name, r.candidates);
    return h.nobody(name);
  };

  // ---- goals ----
  if (
    /^(?:(?:what are|show|list|see) )?(?:me )?my goals$|^goals$|^what am i working (?:toward|towards|on)$/.test(
      lower,
    )
  )
    return h.viaTool('list_goals', {}, undefined, 'list goals');
  {
    const m = text.match(/^(?:track|add|set|save)(?: a| my)? (?:new )?goal(?: of| to| for|:)? (.+)$/i);
    if (m) {
      const what = m[1]!.trim();
      const kind = kindFrom(what);
      if (!kind)
        return {
          kind: 'text',
          text: 'What kind of goal is it: recruiting, fundraising, sales, hiring, advice, a co-founder, community or research collaborators?',
        };
      return h.viaTool('set_goal', { kind, title: what.slice(0, 60) }, undefined, 'track a goal');
    }
  }
  {
    const m = lower.match(
      /^(archive|drop|delete|remove|finish|close)(?: my)? (\S+) goal$|^i'?m done (fundraising|hiring|recruiting)$/,
    );
    if (m) {
      const word = m[2] ?? m[3]!;
      const g = goalNamed(word);
      if (!g)
        return h.viaTool('list_goals', {}, `No ${word} goal is active. These are your goals.`, 'list goals');
      return h.viaTool('archive_goal', { goalId: g.id }, undefined, 'archive a goal');
    }
  }
  {
    const m = lower.match(/^(pause|resume|restart)(?: my)? (\S+) goal$/);
    if (m) {
      const g = goalNamed(m[2]!);
      if (!g)
        return h.viaTool('list_goals', {}, `No ${m[2]} goal is active. These are your goals.`, 'list goals');
      return h.viaTool(
        'update_goal',
        { goalId: g.id, status: m[1] === 'pause' ? 'paused' : 'active' },
        undefined,
        'change a goal',
      );
    }
  }

  // ---- the tie score ----
  {
    const m = text.match(
      /^(?:how close am i (?:to|with)|explain (?!my\b)(.+?)'s (?:score|closeness)|what(?:'s| is) (?!my\b)(.+?)'s (?:score|closeness)|(?:closeness|score) (?:with|for|of))\s*(.*)$/i,
    );
    const name = m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
    if (m && name)
      return withPerson(name, (id) =>
        h.viaTool('explain_score', { personId: id }, undefined, 'explain a score'),
      );
  }
  {
    const barely = text.match(/^i (?:barely|hardly|don'?t really) know (.+)$/i);
    const close = text.match(
      /^(.+?) (?:is|'s) (?:a |my )?(?:very close|close friend|best friend|good friend|close)$/i,
    );
    const rate = text.match(/^rate (.+?) (?:a |as )?([1-5])(?:\s*(?:\/|out of)\s*5)?$/i);
    const hit = barely
      ? { name: barely[1]!, closeness: 1 }
      : rate
        ? { name: rate[1]!, closeness: Number(rate[2]) }
        : close && !/^(who|what|it|that|this)$/i.test(close[1]!)
          ? { name: close[1]!, closeness: /good friend/i.test(text) ? 4 : 5 }
          : undefined;
    if (hit)
      return withPerson(hit.name, (id) =>
        h.viaTool('rate_closeness', { personId: id, closeness: hit.closeness }, undefined, 'rate closeness'),
      );
  }

  // ---- research ----
  {
    const m = text.match(/^(?:research|do (?:some )?research on|dig into)\s+(.+?)(?: before .*)?$/i);
    if (m)
      return withPerson(m[1]!, (id) =>
        h.viaTool('research_person', { personId: id }, undefined, 'research a person'),
      );
  }
  {
    const m = text.match(
      /^(?:what did you find (?:on|about)|show (?:me )?(?:the )?research on|openers for)\s+(.+)$/i,
    );
    const m2 = text.match(/^show (?:me )?(.+?)'s research$/i);
    const name = m?.[1] ?? m2?.[1];
    if (name)
      return withPerson(name, (id) => h.viaTool('get_dossier', { personId: id }, undefined, 'read research'));
  }

  // ---- finding new people ----
  {
    const m = text.match(FIND_WHO);
    if (m) {
      const kind = kindFrom(m[1]!) ?? 'advice';
      return h.viaTool(
        'find_people',
        { purpose: kind, query: text.replace(/^find (?:me )?/i, '') },
        undefined,
        'find people',
      );
    }
  }
  if (
    /^add (?:them(?: all)?|those|the first (?:one|two|three|few)|all of them)(?: to my pipeline)?$/.test(
      lower,
    )
  )
    return {
      kind: 'text',
      text: 'Pick who to add on Discover, under Find people: each result has an Add button.',
      href: '/discover?tab=find',
    };

  // ---- introductions ----
  {
    const m = text.match(
      /^ask (.+?) (?:for an intro(?:duction)? to|to introduce me to|to intro me to) (.+)$/i,
    );
    if (m) {
      const via = m[1]!.toLowerCase();
      const target = h.person(m[2]!);
      const path = h.paths.find(
        (p) =>
          p.firstHopName.toLowerCase().startsWith(via) && (!target.person || p.targetId === target.person.id),
      );
      if (path)
        return h.viaTool(
          'ask_for_intro',
          { pathId: path.id, targetPersonId: path.targetId },
          undefined,
          'ask for an intro',
        );
      if (target.person)
        return h.viaTool(
          'find_routes',
          { personId: target.person.id },
          `These are the routes to ${target.person.displayName}. Ask again for the intro once you see the one through ${m[1]}.`,
          'find routes',
        );
      if (target.candidates.length) return h.ambiguous(m[2]!, target.candidates);
      return h.nobody(m[2]!);
    }
  }

  // ---- replies and booking (account mode; without one, the older phrases keep their meaning) ----
  if (
    h.account &&
    /^(?:who (?:has )?replied(?: to me)?|any (?:new )?replies|show (?:me )?(?:my )?replies|replies|what did people say back)$/.test(
      lower,
    )
  )
    return h.viaTool('list_replies', {}, undefined, 'list replies');
  if (
    h.account &&
    /^(?:who wants to (?:meet|talk)|who is picking a time|replies (?:about|picking a) times?)$/.test(lower)
  )
    return h.viaTool('list_replies', { replyClass: 'scheduling' }, undefined, 'list replies');
  {
    const m = text.match(/^(?:answer|reply to|draft a reply to) (.+?)'s (?:reply|message|email|question)$/i);
    if (m)
      return h.viaTool(
        'list_replies',
        {},
        `Here are your replies. Tap Draft reply on ${m[1]}'s to write the answer in your voice.`,
        'list replies',
      );
  }
  if (/^book (?:it|the call|that time|a call)$/.test(lower))
    return h.viaTool(
      'list_replies',
      { replyClass: 'scheduling' },
      'Pick the time on the reply, then confirm the booking there.',
      'list replies',
    );

  // ---- autonomy ----
  {
    const m = lower.match(/^(?:set )?autonomy(?: level)?(?: to)? ([0-2])$/);
    const level = m
      ? Number(m[1])
      : /^(?:go back to |switch to |set )?draft only$/.test(lower)
        ? 0
        : /^(?:switch to |set )?send (?:it )?after i approve$/.test(lower)
          ? 1
          : /^(?:let orbit |you can )?(?:send simple replies for me|confirm (?:meeting )?times for me)$/.test(
                lower,
              )
            ? 2
            : undefined;
    if (level !== undefined) return h.viaTool('set_autonomy', { level }, undefined, 'change autonomy');
  }

  // ---- pause and what is due ----
  {
    const m = text.match(/^pause (?:my |all )?outreach(?: until (.+))?$/i);
    if (m) {
      const until = m[1] ? dateFrom(m[1]) : undefined;
      if (!until)
        return { kind: 'text', text: 'Until when? Say a date, like "pause outreach until Dec 20".' };
      return h.viaTool('pause_outreach', { until }, undefined, 'pause outreach');
    }
    if (/^(?:resume|restart|unpause) (?:my )?outreach$/.test(lower))
      return h.viaTool('pause_outreach', {}, undefined, 'resume outreach');
  }
  if (
    h.account &&
    /^(?:what(?:'s| is) due|what follow-?ups are due|(?:show )?due follow-?ups|who should i check in with|what is orbit (?:about to|going to) send)$/.test(
      lower,
    )
  )
    return h.viaTool('list_due', {}, undefined, 'list what is due');

  // ---- memory ----
  {
    const m = text.match(/^(?:please )?remember(?: that)? (.+)$/i);
    if (m) {
      const what = m[1]!.trim();
      const kind = /\b(prefer|rather|like|love|hate|always|never|morning|evening)\b/i.test(what)
        ? 'preference'
        : /\b(can'?t|cannot|only|unavailable|busy)\b/i.test(what)
          ? 'constraint'
          : 'note';
      return h.viaTool('remember', { text: what.slice(0, 300), kind }, undefined, 'remember something');
    }
  }
  {
    const m = text.match(/^what do you remember(?: about (.+))?$/i);
    if (m) {
      const about = m[1]?.trim();
      const p = about ? h.person(about) : undefined;
      if (p?.person)
        return h.viaTool(
          'recall',
          { query: p.person.displayName, personId: p.person.id },
          undefined,
          'recall',
        );
      return h.viaTool('recall', { query: about ?? 'preferences and goals' }, undefined, 'recall');
    }
  }
  {
    const m = text.match(/^forget (?:everything )?(?:about |you know about )?(.+)$/i);
    if (m && !/^(it|that|this|about it)$/i.test(m[1]!)) {
      const p = h.person(m[1]!);
      if (p.person) return h.viaTool('forget', { personId: p.person.id }, undefined, 'forget');
    }
    if (m)
      return {
        kind: 'text',
        text: 'You can see and delete what Orbit remembers under Settings, Memory.',
        href: '/settings/memory',
      };
  }
  return undefined;
}
