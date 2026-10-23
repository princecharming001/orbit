import type { MessageKind } from '@orbit/core';
import type { MatchablePerson } from './people-match';
import type { RouterIntent } from './router';
import type { ThreadContext } from './routerThread';
import { shortenMessage } from './shorten';

/**
 * The no-key router's follow-ups: a message read against what the conversation just showed (routerThread.ts).
 * `resolveReferences` turns "her", "the second one" or "the top 3" into the names they point at, so the ordinary
 * phrases take it from there; `followUp` handles what only makes sense after a card: "do it", "send it", "make it
 * shorter", "and Dan?", "ask Maya", "wait a week", "what should I ask".
 */
export interface FollowHelpers {
  viaTool: (tool: string, input: Record<string, unknown>, lead?: string, what?: string) => RouterIntent;
  person: (name: string) => { person?: MatchablePerson; candidates: MatchablePerson[] };
  nobody: (name: string) => RouterIntent;
  ambiguous: (name: string, candidates: MatchablePerson[]) => RouterIntent;
  findKind: (text: string) => MessageKind | undefined;
  /** route another message (a chip's own words) with the same context, minus the last card's steps */
  reroute: (message: string) => RouterIntent;
  cards: { id: string; personId?: string; kind: string }[];
}

const ORDINALS: Record<string, number> = {
  first: 0,
  '1st': 0,
  one: 0,
  '1': 0,
  second: 1,
  '2nd': 1,
  two: 1,
  '2': 1,
  third: 2,
  '3rd': 2,
  three: 2,
  '3': 2,
  fourth: 3,
  '4th': 3,
  four: 3,
  '4': 3,
  fifth: 4,
  '5th': 4,
  five: 4,
  '5': 4,
};
const COUNT: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, '2': 2, '3': 3, '4': 4, '5': 5 };
const ORD = '(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)';
/** "all of them" drafts to the first five, the rows a folded list shows and the most a next-step chip drafts */
const EACH_MAX = 5;

/** "A, B and C" */
const listOf = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

function ordinal(word: string, n: number): number {
  return word === 'last' ? n - 1 : (ORDINALS[word] ?? -1);
}

/** Words after "her" that make it the person ("ask her for", "write to her now"), not "her draft". */
const OBJECT_NEXT =
  /^(for|about|to|on|in|at|a|an|the|and|now|again|today|tomorrow|first|back|up|that|this|with|before|after|instead|too|as|if|or|yet|please|directly|myself|anyway|is|was|has|had|did|does|said|wrote|replied|knows?)$/i;

/** Point "her", "them", "the second one", "the top 3" and "all of them" at the people the conversation just showed. */
export function resolveReferences(text: string, t: ThreadContext): string {
  let out = text;
  const list = t.list ?? [];
  const names = list.map((p) => p.name);
  if (names.length) {
    // "the top 3", "the first two", "the top three people"
    out = out.replace(
      /\b(?:the )?(?:top|first) (two|three|four|five|[2-5])(?: (?:people|ones|of them|names|contacts|on the list))?\b/i,
      (_, n: string) => `each of: ${listOf(names.slice(0, COUNT[n.toLowerCase()] ?? 3))}`,
    );
    // "all of them", "each of them", "everyone on the list", "both", "them all"
    out = out.replace(
      /\b(?:all|each|every one|everyone) of (?:them|those|these|those people)\b|\beveryone (?:on|in) (?:the|that|this) list\b|\bthem all\b|\bboth(?: of them)?\b|\ball (?:five|four|three|two|[2-9])\b/i,
      () => `each of: ${listOf(names.slice(0, EACH_MAX))}`,
    );
    // "the second one", "the 3rd person", "number 2"
    out = out.replace(
      new RegExp(
        `\\b(?:the |my )${ORD}(?: (?:one|person|name|guy|contact|of them|on the list))?\\b(?!\\s+(?:message|draft|email|note|time|chat|route|step))|\\b${ORD} (?:one|person|of them)\\b|\\bnumber ([1-5])\\b|#([1-5])\\b`,
        'i',
      ),
      (m, a?: string, b?: string, c?: string, d?: string) => {
        const word = (a ?? b ?? c ?? d ?? '').toLowerCase();
        const i = ordinal(word, names.length);
        return i >= 0 && i < names.length ? names[i]! : m;
      },
    );
    if (t.listIsNewest)
      out = out.replace(
        /\b(?:them|those people|these people|those|these)\b(?!\s+(?:drafts?|messages?))/i,
        () => `each of: ${listOf(names.slice(0, EACH_MAX))}`,
      );
  }
  if (t.focus && !names.length)
    // one person shown: "all of them" or "both" is that one
    out = out.replace(
      /\b(?:all|each|every one) of (?:them|those|these)\b|\bthem all\b|\bboth(?: of them)?\b/i,
      t.focus.name,
    );
  if (t.focus) {
    const name = t.focus.name;
    out = out
      .replace(
        /\b(?:the person I just added|the new (?:contact|person)|this (?:person|contact)|that (?:person|contact)|the person on (?:that|this) card)\b/gi,
        name,
      )
      .replace(/\b(her|him|hers|she|he)\b(\s+(\S+))?/gi, (_m, pro: string, rest?: string, next?: string) => {
        const p = pro.toLowerCase();
        if (p === 'her' && next && !OBJECT_NEXT.test(next.replace(/[^\w']/g, '')))
          return `${name}'s${rest ?? ''}`;
        return `${name}${rest ?? ''}`;
      })
      .replace(/\b(his|their)\b/gi, `${name}'s`);
    if (!t.listIsNewest) out = out.replace(/\bthem\b(?!\s+(?:all|both))/i, name);
  }
  return out;
}

/** "looks good" about a draft: send it (Approve still decides) */
const LOOKS_GOOD = /^(looks good|looks great|that works|good to go|ship it|send it as is)(,? send it)?$/i;

const YES =
  /^(yes|yeah|yep|yup|ya|sure|ok(?:ay)?,? do (?:it|that)|do it|do that|go ahead|go for it|let'?s do (?:it|that)|please do|yes,? please|sounds good,? do it|that one|ok go|yes do it|sure,? go ahead|perfect,? do it|let'?s go)$/i;

/** What a message means right after a card, when it only makes sense there. */
export function followUp(text: string, t: ThreadContext, h: FollowHelpers): RouterIntent | undefined {
  const lower = text
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .trim();
  const drafts = (t.drafts ?? []).filter((d) => d.status === 'draft' || d.status === 'failed');
  const focusDraft =
    drafts.find((d) => d.personId === t.focus?.id) ?? (drafts.length === 1 ? drafts[0] : undefined);

  if (LOOKS_GOOD.test(lower) && t.lastKind === 'draft' && focusDraft)
    return h.viaTool('send_draft', { draftId: focusDraft.id }, undefined, 'send a draft');

  // ---- "yes", "do it": the card's first next step, or its first pill ----
  if (YES.test(lower)) {
    if (t.pending)
      return {
        kind: 'text',
        text: 'Tap Approve on the card above when it looks right. Nothing goes out before that.',
      };
    if (t.choices?.length) return h.reroute(t.choices[0]!.message);
    if (t.steps?.length) return h.reroute(t.steps[0]!.message);
    // right after a draft: "yes" means send it, which still waits for Approve
    if (t.lastKind === 'draft' && focusDraft)
      return h.viaTool('send_draft', { draftId: focusDraft.id }, undefined, 'send a draft');
    return undefined;
  }

  // ---- "the second one", "option 2": a pill, a next step, or a person on the list ----
  {
    const m = lower.match(
      new RegExp(
        `^(?:the |option |choice |number |#)?${ORD.replace(')', '|[1-5])')}(?: one| option| choice)?$`,
      ),
    );
    if (m) {
      const word = m[1]!;
      if (t.choices?.length) {
        const i = ordinal(word, t.choices.length);
        if (t.choices[i]) return h.reroute(t.choices[i]!.message);
      }
      const list = t.list ?? [];
      const i = ordinal(word, list.length);
      if (list[i]) return h.viaTool('get_person', { personId: list[i]!.id }, undefined, 'open a person');
      const steps = t.steps ?? [];
      const j = ordinal(word, steps.length);
      if (steps[j]) return h.reroute(steps[j]!.message);
    }
  }

  // ---- the draft just made or shown: send, shorten, discard, switch kind, show, reset ----
  {
    const which = lower.match(
      new RegExp(
        `^(?:send|approve|ship)(?: off)? (?:the |my )?${ORD}(?: one| draft| message| email)?(?: now)?$`,
      ),
    );
    if (which) {
      const i = ordinal(which[1]!, drafts.length);
      const d = drafts[i];
      if (d) return h.viaTool('send_draft', { draftId: d.id }, undefined, 'send a draft');
    }
    if (
      /^(?:send|approve|ship)(?: it| this| that| the (?:draft|message|email|note)| my (?:draft|message))?(?: off)?(?: now| as is| as drafted)?$|^(?:ok,? )?send it(?: as drafted)?$|^(?:looks good,? )?send$/.test(
        lower,
      )
    ) {
      if (t.pending?.tool === 'send_draft')
        return {
          kind: 'text',
          text: 'Tap Approve on the card above to send it. Nothing goes out before that.',
        };
      if (focusDraft) return h.viaTool('send_draft', { draftId: focusDraft.id }, undefined, 'send a draft');
      if (drafts.length > 1)
        return {
          kind: 'text',
          text: `Which one? Say "send the first" or name them, like: send my draft to ${drafts[0]!.name.split(' ')[0]}.`,
        };
    }
    if (
      /^(?:send|approve) (?:them|these|all|all of them|them all|both|all \w+)(?: now)?$/.test(lower) &&
      drafts.length > 1
    )
      return h.viaTool(
        'send_draft',
        { draftId: drafts[0]!.id },
        'One at a time, so you can read each before it goes. Here is the first.',
        'send a draft',
      );
    const shorten =
      /^(?:(?:can|could) you )?(?:make (?:it|this|that|them|these|the (?:draft|message|email|note)s?) )?(?:a (?:bit|little|lot) )?(?:shorter|more concise|briefer|tighter|less wordy)(?: please)?$|^(?:shorten|trim|tighten|cut)(?: it| this| that| them| these| the (?:draft|message|email|note)s?)?(?: down| a bit| up)?$|^(?:too long|it'?s too long|that'?s too long|they'?re too long)$/.test(
        lower,
      );
    if (shorten && !focusDraft && drafts.length > 1)
      return h.viaTool(
        'offer_choices',
        {
          options: drafts.slice(0, 3).map((d) => ({
            label: `The one to ${d.name.split(' ')[0]}`,
            message: `Shorten my draft to ${d.name}`,
          })),
        },
        'Which one should I shorten?',
        'ask which draft',
      );
    if (focusDraft && shorten) {
      const short = shortenMessage(focusDraft.body);
      if (short === focusDraft.body.trim())
        return {
          kind: 'text',
          text: `The message to ${focusDraft.name.split(' ')[0]} is already short. Edit it in the card if you want it different.`,
        };
      return h.viaTool(
        'update_draft_body',
        { draftId: focusDraft.id, body: short },
        'Cut it down to the ask. Edit anything in the card.',
        'shorten a draft',
      );
    }
    if (
      focusDraft &&
      /^(?:discard|delete|drop|scrap|bin|trash|throw away|throw out|get rid of)(?: it| this| that| the (?:draft|message|email|note)| this draft| that draft)$/.test(
        lower,
      )
    )
      return h.viaTool('discard_draft', { draftId: focusDraft.id }, undefined, 'discard a draft');
    if (
      focusDraft &&
      /^(?:show|open|read|see)(?: me)? (?:it|that|this|the draft|the message)(?: again)?$/.test(lower)
    )
      return h.viaTool('get_draft', { draftId: focusDraft.id }, undefined, 'open a draft');
    if (
      focusDraft &&
      /^(?:reset|redo|start over|go back to (?:the|orbit'?s) (?:suggested |original )?(?:text|version)|undo my (?:edits|changes))(?: it| on it)?$/.test(
        lower,
      )
    )
      return h.viaTool(
        'manage_draft',
        { draftId: focusDraft.id, action: 'reset_to_suggested' },
        undefined,
        'reset a draft',
      );
    const switchKind = lower.match(
      /^(?:make it|make this|switch (?:it|this) to|change (?:it|this) to|turn (?:it|this) into|write|do|actually,? (?:make it|write)) (?:a |an )?(.+?)(?: instead)?$/,
    );
    const kind = switchKind ? h.findKind(switchKind[1]!) : undefined;
    if (switchKind && kind && kind !== 'outreach' && t.focus)
      return h.viaTool('create_draft', { personId: t.focus.id, kind }, undefined, 'start a draft');
  }

  // ---- "undo that" right after a move ----
  if (
    /^(?:undo|revert|take back)(?: that| it| this| the move| that move| the last move)?$|^(?:oops|wait),? undo(?: that| it)?$/.test(
      lower,
    )
  ) {
    const personId = typeof t.last?.input.personId === 'string' ? t.last.input.personId : t.focus?.id;
    if (
      personId &&
      (t.last?.tool === 'move_pipeline_stage' || t.last?.tool === 'answer_stage_question' || t.focus)
    )
      return h.viaTool('undo_stage_move', { personId }, undefined, 'undo a move');
  }

  // ---- "and Dan?", "what about Lena?": the same question about someone else ----
  {
    const m = text.match(/^(?:and|what about|how about|same for|and for|now)\s+(.+?)\??$/i);
    if (m && t.last && !/^(?:it|that|this|them|me)$/i.test(m[1]!.trim())) {
      const r = h.person(m[1]!);
      if (r.person)
        return h.viaTool(t.last.tool, { ...t.last.input, personId: r.person.id }, undefined, 'do the same');
      if (r.candidates.length) return h.ambiguous(m[1]!, r.candidates);
    }
  }

  // ---- after routes: "ask Maya", "go through the first one" ----
  if (t.target) {
    const m = text.match(
      /^(?:ok(?:ay)?,? )?(?:ask|go through|use|try|have|get)\s+(.+?)(?:\s+(?:for (?:the |an )?intro(?:duction)?|to (?:intro|introduce) (?:me|us)|to make the intro))?(?: then| instead)?$/i,
    );
    const via = m?.[1]?.replace(/^(?:the )?(?:route|path) (?:through|via) /i, '').trim();
    if (via && !/^(?:me|it|them|her|him)$/i.test(via)) {
      const ord = via.match(new RegExp(`^(?:the )?${ORD}(?: one| route| path| person)?$`, 'i'));
      const intros = t.introducers ?? [];
      const name = ord ? intros[ordinal(ord[1]!.toLowerCase(), intros.length)] : via;
      if (name) {
        const r = h.person(name);
        if (r.person && r.person.id !== t.target.id)
          return h.reroute(`Draft an intro request to ${r.person.displayName} for ${t.target.name}`);
        if (r.candidates.length) return h.ambiguous(name, r.candidates);
      }
    }
  }

  // ---- "wait a week", "remind me in 3 days", "not yet": the card about this person waits ----
  {
    const m = lower.match(
      /^(?:actually,? |hmm,? |ok,? )?(?:let'?s )?(?:wait|hold off|hold on|hold it|not yet|later|snooze (?:it|this|that))(?: on (?:it|that|this))?(?: for)?(?: (a|one|two|three|a few|\d+) (day|days|week|weeks))?(?: (?:first|then|instead))?$|^(?:remind me|bring it back|ask me again)(?: about (?:it|this|that))? (?:in|next) (a|one|two|three|\d+)? ?(day|days|week|weeks)$|^(?:push it to|wait until|do it) (tomorrow|next week)$/,
    );
    if (m && (t.focus || focusDraft)) {
      const nWord = (m[1] ?? m[3] ?? '').toLowerCase();
      const unit = m[2] ?? m[4] ?? (m[5] === 'next week' ? 'week' : m[5] === 'tomorrow' ? 'day' : undefined);
      const n =
        nWord === 'a' || nWord === 'one' || nWord === ''
          ? 1
          : nWord === 'a few'
            ? 3
            : (COUNT[nWord] ?? (Number(nWord) || 1));
      const days = unit?.startsWith('week') ? n * 7 : unit ? n : 3;
      const personId = t.focus?.id ?? focusDraft?.personId;
      const card = h.cards.find((c) => c.personId === personId);
      const name = (t.focus?.name ?? focusDraft?.name ?? '').split(' ')[0];
      if (card)
        return h.viaTool(
          'manage_suggestion',
          { suggestionId: card.id, action: 'snooze', days: Math.min(30, days) },
          undefined,
          'snooze a card',
        );
      return {
        kind: 'text',
        text: `Okay. The draft to ${name} waits in Drafts and nothing goes out until you send it. Ask me again when you're ready.`,
        href: '/inbox',
      };
    }
  }

  // ---- after prep: "what should I ask", "any questions" ----
  if (
    t.focus &&
    /^(?:so )?what (?:should|do|can|could) i ask(?: (?:her|him|them|about))?$|^(?:any|some|give me) (?:good )?questions(?: to ask)?(?: (?:her|him|them))?$|^questions(?: to ask)?$|^what should i bring up$/.test(
      lower,
    )
  )
    return h.viaTool('get_person', { personId: t.focus.id, include: ['prep'] }, undefined, 'prep for a chat');

  return undefined;
}
