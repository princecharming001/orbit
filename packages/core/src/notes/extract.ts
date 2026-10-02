import type { FactType, NoteExtraction } from '../types';

const OFFER =
  /\b(happy to (refer|intro|introduce|connect|review|look at|share|send)|i can (refer|intro|introduce|connect|send|share|put)|i'?ll (refer|intro|introduce|send|share|forward|put in a (good )?word|connect you)|(he|she|they) will (send|share|forward|intro|refer)|offered to|said (he|she|they)'?d)\b/i;
const USER_ACTION =
  /\b(i (will|should|need to|have to|promised to|said i'?d|told (him|her|them) i'?d|owe)|follow up (with|on)|send (him|her|them)|share my|apply (to|by)|reach out to|action items?:|todo:|to-?do:|next steps?:)\b/i;
const ADVICE =
  /\b(advice|recommend(ed|s)?|suggest(ed|s)?|tip|should (focus|prepare|practice|apply|read|try|reach)|the key is|what matters|make sure (you|to))\b/i;
const ROLE =
  /\b(works? (on|in|with)|team (is|does|owns)|role (is|involves)|responsible for|leads?|manages?|joined .* (in|as)|been at .* (for|since))\b/i;
const PERSONAL =
  /\b(hometown|grew up|from .* originally|hobby|hobbies|marathon|hiking|climbing|cooking|guitar|piano|travel(ed|ing)?|kids?|dog|cat|moved to|lives in|weekend)\b/i;
const HOOK =
  /\b(hiring (in|for|next)|headcount|opening (up|in)|launch(ing)?|conference|offsite|next (month|quarter|week)|in (january|february|march|april|may|june|july|august|september|october|november|december))\b/i;
const WARM = /\b(happy|great|love(d)?|excited|awesome|enjoyed|pleasure|anytime|definitely|absolutely)\b/i;
const COOL = /\b(busy|not sure|can'?t promise|no guarantee|hard to say|unfortunately)\b/i;

function sentences(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split(/(?<=[.!?])\s+|\n+|•|^- /m)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((s) => s.length > 12 && s.length < 400);
}

export function heuristicNoteExtraction(text: string, counterpartName?: string): NoteExtraction {
  const sents = sentences(text);
  const about = counterpartName ?? 'them';
  const facts: NoteExtraction['facts'] = [];
  const actionItems: NoteExtraction['actionItems'] = [];
  const offers: string[] = [];
  const hooks: string[] = [];
  let warm = 0;
  let cool = 0;
  const push = (type: FactType, s: string, confidence = 0.7) => {
    if (facts.some((f) => f.text === s)) return;
    facts.push({ about, type, text: s, confidence });
  };
  for (const s of sents) {
    if (WARM.test(s)) warm++;
    if (COOL.test(s)) cool++;
    if (OFFER.test(s)) {
      offers.push(s);
      push('offer', s, 0.75);
      continue;
    }
    if (USER_ACTION.test(s)) {
      const due = s.match(
        /\b(by|before|on|next)\s+((monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|week|month|friday|eod|end of (the )?(week|month))\b[^.,;]*)/i,
      )?.[0];
      actionItems.push({
        owner: 'user',
        text: s.replace(/^(action items?|todo|to-do|next steps?):\s*/i, ''),
        dueHint: due,
      });
      continue;
    }
    if (PERSONAL.test(s) && !/\b(hiring|launch|headcount|opening)\b/i.test(s)) {
      push('personal', s, 0.55);
      continue;
    }
    if (HOOK.test(s)) {
      hooks.push(s);
      push('hook', s, 0.65);
      continue;
    }
    if (ADVICE.test(s)) push('advice', s, 0.7);
    else if (ROLE.test(s)) push('role_detail', s, 0.65);
  }
  const summarySents = sents.slice(0, 3);
  const summary = summarySents.join(' ').slice(0, 600) || text.slice(0, 300);
  const warmth: NoteExtraction['warmth'] = warm > cool + 1 ? 'warm' : cool > warm ? 'cool' : 'neutral';
  const suggestedNextStep = offers.length
    ? `Follow up on their offer: "${offers[0]!.slice(0, 80)}"`
    : actionItems.length
      ? `Do what you promised: "${actionItems[0]!.text.slice(0, 80)}"`
      : 'Send a thank-you within 24 hours that references one specific thing from the conversation.';
  return {
    summary,
    facts: facts.slice(0, 15),
    actionItems: actionItems.slice(0, 8),
    offers,
    hooks,
    warmth,
    suggestedNextStep,
  };
}

/** Recognise Granola's share-by-email / paste format and split summary from transcript. */
export function parseGranolaText(text: string): {
  title?: string;
  summary?: string;
  body: string;
  attendees: { name: string }[];
} {
  const lines = text.split('\n');
  let title: string | undefined;
  if (lines[0] && lines[0].length < 120 && !/^(summary|notes|transcript)/i.test(lines[0]))
    title = lines[0].replace(/^#\s*/, '').trim();
  const attendees: { name: string }[] = [];
  const att = text.match(/^(attendees|participants|with):\s*(.+)$/im);
  if (att?.[2]) for (const n of att[2].split(/,|&| and /)) if (n.trim()) attendees.push({ name: n.trim() });
  const idx = text.search(/^#{0,3}\s*(transcript)\b/im);
  const summaryIdx = text.search(/^#{0,3}\s*(summary|notes|key takeaways)\b/im);
  const summary =
    summaryIdx >= 0
      ? text
          .slice(summaryIdx, idx > summaryIdx ? idx : undefined)
          .replace(/^#{0,3}\s*\w+\s*\n/, '')
          .trim()
      : undefined;
  return { title, summary, body: text, attendees };
}
