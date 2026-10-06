import type { FactType, NoteExtraction } from '../types';

/**
 * Heuristic note extraction (the path every user without an API key takes).
 *
 * Input is whatever the student pasted or dictated: a Granola summary, a transcript with speaker labels,
 * a typed paragraph, or an unpunctuated voice note. Output facts are stored as clean clauses about the
 * counterpart in the second person ("you lead a small team on payments onboarding"), so they read
 * correctly after "you mentioned ...", with the raw sentence kept as `evidence`. The student's own
 * promises become action items, never offers. With several attendees each fact goes to the person the
 * sentence is about (nearest name mention, a pronoun inherits the previous subject).
 */

export interface NotePerson {
  /** stable key written to `about` (a person id in the app) */
  key: string;
  first: string;
  last?: string;
}

export interface NoteExtractionOptions {
  /** first name of the single counterpart (older call style) */
  counterpartName?: string;
  /** everyone the note is about, primary first */
  people?: NotePerson[];
  /** the student's own names, to recognise their speaker label */
  userNames?: string[];
}

type Speaker = 'user' | 'counterpart' | undefined;
interface Line {
  text: string;
  speaker: Speaker;
  speakerKey?: string;
  actions: boolean;
}

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const MONTH_SHORT = 'jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';

const ROLE =
  /\b(works? (on|in|with|at)|working on|team (is|does|owns|works)|role (is|involves)|responsible for|leads?|leading|manages?|managing|runs?|owns?|joined|been at|started (at|on|in)|moved (from|over)|transferred|switched|is (a|an|the) [a-z ]*(engineer|manager|analyst|associate|designer|lead|director|partner|consultant|recruiter|vp))\b/i;
/** a job move ("moved to Datadog from Square") rather than a home move ("moved to Boston") */
const ROLE_SWITCH =
  /\b(moved|switched|went|came)\s+(to|from|over to)\s+\S+(\s+\S+)?\s+(from|to)\s+\S+|\bjoined\b|\bswitched\b/i;
const PERSONAL =
  /\b(hometown|grew up|originally from|from [a-z]+ originally|hobby|hobbies|marathon|hiking|climbing|bouldering|cooking|baking|guitar|piano|surfing|skiing|travel(ed|ing|s)?|kids?|daughter|son|wife|husband|dog|cat|corgi|puppy|pet|moved to|moved from|lives? in|weekends?|went to (college|school)|studied|alum|alumna|alumnus|played|plays|wedding|new baby|vacation)\b/i;
const HOOK = new RegExp(
  `\\b(hiring|headcount|opening (up|in)|opens? (in|on|up)|applications? (open|close|are due)|posting|deadline|launch(ing|es|ed)?|ships?|shipping|conference|offsite|reorg|new (team|role|product|office)|promotion|promoted|next (month|quarter|week|year)|this (fall|spring|summer|winter)|in (${MONTHS})|recruiting (starts|kicks off|opens))\\b`,
  'i',
);
const ADVICE =
  /\b(advice|advised|recommend(ed|s)?|suggest(ed|s)?|tips?|should (focus|prepare|practice|apply|read|try|reach|network|talk|learn|start)|the (key|trick|main thing|biggest thing|best thing)( thing)? (is|was)|what matters|make sure|focus on|don't|do not|avoid|practice|prepare|values?|looks? for|cares? about|wants? to see|important|my advice)\b/i;
const WARM =
  /\b(happy|great|love(d)?|excited|awesome|enjoyed|pleasure|anytime|definitely|absolutely|nice|friendly|generous|helpful)\b/i;
const COOL =
  /\b(busy|not sure|can'?t promise|no guarantee|hard to say|unfortunately|swamped|rushed|distracted)\b/i;
const OFFER_VERB =
  /\b(refer|referral|intro|introduce|connect (me|you)|send|share|forward|review|look (over|at)|put in a (good )?word|pass (it |my resume |that )?along|loop (me|you) in|set up|ping|flag|cc)\b/i;
const OFFER_FRAME =
  /\b(offered to|happy to|glad to|would love to|'d love to|can|could|will|'ll|'d|would|is going to|'s going to|going to)\b/i;

const NON_SPEAKER_LABELS = new Set([
  'note',
  'notes',
  'summary',
  'action items',
  'action item',
  'todo',
  'to-do',
  'todos',
  'next steps',
  'next step',
  'takeaway',
  'takeaways',
  'key takeaways',
  'update',
  're',
  'ps',
  'fyi',
  'advice',
  'offer',
  'hook',
  'ask',
  'question',
  'answer',
  'q',
  'a',
  'attendees',
  'participants',
  'with',
  'date',
  'time',
  'location',
  'title',
  'subject',
  'agenda',
  'topic',
  'topics',
  'follow up',
  'follow-up',
  'reminder',
  'important',
  'background',
]);

const HEADER_LINE =
  /^(attendees|participants|with|date|time|when|where|location|title|subject|meeting|duration|recorded|created|agenda|calendar|event|link|zoom|google meet)\s*:/i;
const SECTION_LINE =
  /^#{0,4}\s*(summary|notes|meeting notes|key takeaways|takeaways|highlights|transcript|action items?|next steps?|to-?dos?|follow[- ]?ups?|discussion|details|overview)\s*:?\s*$/i;
const ACTION_SECTION = /^(action items?|next steps?|to-?dos?|follow[- ]?ups?)$/i;

const SPEAKER =
  /^(?:\[?\(?\d{1,2}:\d{2}(?::\d{2})?\)?\]?\s*[-–]?\s*)?([A-Z][\p{L}.'’-]*(?:\s+[A-Z][\p{L}.'’-]*){0,3}|Me|Them|You|Speaker \d)\s*(?:\(\d{1,2}:\d{2}(?::\d{2})?\)|\[\d{1,2}:\d{2}(?::\d{2})?\])?\s*:\s+(.+)$/u;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Strip filler words and spoken tics, fix the student's lowercase "i". */
function clean(s: string): string {
  return s
    .replace(/\b(?:um+|uh+|erm|hmm+|mhm)\b[,.]?\s*/gi, '')
    .replace(/\b(?:you know|i mean)\b,?\s*/gi, '')
    .replace(/\b(?:honestly|basically|literally|totally|actually)\b,?\s*/gi, '')
    .replace(new RegExp(`\\b(${MONTHS})\\b`, 'g'), (m) => m[0]!.toUpperCase() + m.slice(1))
    .replace(/\b(in|by|around|about|at|for|was|is|are|it's|just|said|and|so|like)\s+like\s+(?!to\b)/gi, '$1 ')
    .replace(/(^|,\s*)like\s+/gi, '$1')
    .replace(/\bi\b/g, 'I')
    .replace(/\bI('m|'ll|'d|'ve)\b/gi, (_, x: string) => `I${x.toLowerCase()}`)
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const CONNECTOR =
  /^(?:quick note|note to self|notes|recap|update|fyi|and|so|but|also|then|plus|oh|ok|okay|anyway|anyways|well|yeah|yes|like|right|that's great|that's awesome|great|nice|cool|sure|of course|for sure|totally|absolutely|actually|anyhow)\b[,!.]?\s+/i;
function stripConnectors(s: string): string {
  let out = s.trim();
  for (let i = 0; i < 4 && CONNECTOR.test(out); i++) out = out.replace(CONNECTOR, '');
  return out.replace(/^[,;:\s]+|[,;:\s]+$/g, '');
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
const BREAK_WORDS = new Set([
  'um',
  'uh',
  'erm',
  'also',
  'anyway',
  'anyways',
  'plus',
  'so',
  'but',
  'then',
  'okay',
  'ok',
]);
const SUBJECTS = new Set(['she', 'he', 'they', 'i', 'we']);

/**
 * Split an unpunctuated run-on (a dictated note) at discourse markers: "um", "also", "so", "but",
 * "and she ...", and before a reporting verb that has no subject ("she was nice said the process ...").
 */
const FILLER_TOKENS = new Set([
  'um',
  'uh',
  'erm',
  'so',
  'ok',
  'okay',
  'like',
  'basically',
  'honestly',
  'and',
  'also',
  'then',
  'oh',
]);
const NO_SPLIT_BEFORE_PRONOUN =
  /^(said|says|that|if|when|because|and|but|so|as|since|while|until|before|after|where|what|how|who|why|think|thought|mentioned|told|guess|hope|know|knew|which|whether|than|like|cuz|cause|said|feel|felt|believe|wish|unless|though|although|also|then)$/;
function splitRunOn(s: string, names: Set<string>): string[] {
  const toks = s.split(/\s+/).filter(Boolean);
  const segs: string[][] = [[]];
  const content = (seg: string[]) =>
    seg.filter((t) => !FILLER_TOKENS.has(t.toLowerCase().replace(/[^a-z']/g, ''))).length;
  const push = (first?: string) => {
    const cur = segs[segs.length - 1]!;
    while (cur.length && /^(and|but|so|or|then|also)$/i.test(cur[cur.length - 1]!.replace(/[^a-z]/gi, '')))
      cur.pop();
    segs.push(first ? [first] : []);
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const k = t.toLowerCase().replace(/[^a-z']/g, '');
    const next = (toks[i + 1] ?? '').toLowerCase().replace(/[^a-z']/g, '');
    const prev = (toks[i - 1] ?? '').toLowerCase().replace(/[^a-z']/g, '');
    const cur = segs[segs.length - 1]!;
    const n = content(cur);
    if (BREAK_WORDS.has(k) && n >= 3) {
      push();
      continue;
    }
    if (
      k === 'and' &&
      n >= 3 &&
      (SUBJECTS.has(next) || names.has(next) || /^(her|his|their|my|the)$/.test(next))
    ) {
      push();
      continue;
    }
    // "... at the info session elena said ..." -> a new clause starts at the name
    if (
      names.has(k) &&
      n >= 3 &&
      !names.has(prev) &&
      !/^(and|with|to|from|for|by|about|asked|met|told|thanked|emailed)$/.test(prev)
    ) {
      push(t);
      continue;
    }
    // "... last month he's training ..." -> a new clause starts at the pronoun
    if (
      /^(she|he|they|she's|he's|they're|she'd|he'd)$/.test(k) &&
      n >= 4 &&
      !NO_SPLIT_BEFORE_PRONOUN.test(prev) &&
      !names.has(prev)
    ) {
      push(t);
      continue;
    }
    if (
      /^(said|mentioned|told|recommended|suggested)$/.test(k) &&
      n >= 3 &&
      !SUBJECTS.has(prev) &&
      !names.has(prev) &&
      !/^(also|just|then|and|she's|he's|who|that|had|has|have|was|were|is|i've|we)$/.test(prev) &&
      !/^[A-Z]/.test(toks[i - 1] ?? '')
    ) {
      push(t);
      continue;
    }
    cur.push(t);
  }
  const out: string[] = [];
  for (const seg of segs) {
    const text = seg.join(' ').trim();
    if (!text) continue;
    if (wordCount(text) < 3 && out.length) out[out.length - 1] = `${out[out.length - 1]} ${text}`;
    else out.push(text);
  }
  return out;
}

/** Sentences of a line; long sentences with little punctuation are split into clauses. */
function sentencesOf(line: string, names: Set<string>): string[] {
  const out: string[] = [];
  for (const raw of line.split(/(?<=[.!?])\s+(?=["'“(]?[A-Za-z0-9])|\s+•\s+/)) {
    const s = raw
      .replace(/^[-*•]\s*/, '')
      .replace(/^\d+[.)]\s+/, '')
      .trim();
    if (!s) continue;
    const words = wordCount(s);
    const punct = (s.match(/[,;.!?]/g) ?? []).length;
    const clauses = words > 60 || (words > 25 && punct < words / 15) ? splitRunOn(s, names) : [s];
    for (const c of clauses) out.push(...splitCompound(c));
  }
  return out;
}

/**
 * "Elena works on healthcare cases and recommended I apply early" -> two clauses with the same subject,
 * so the role detail and the advice are classified separately.
 */
function splitCompound(s: string): string[] {
  const mine = s.match(
    /^(.{12,}?),?\s+and\s+(I\s+(?:owe|need to|have to|will|should|promised|must)\b.*|I'll\b.*)$/,
  );
  if (mine) return [...splitCompound(mine[1]!), mine[2]!];
  const that = s.match(
    /^((\S+(?:\s+[A-Z][\p{L}'-]+)?)\s+(said|says|mentioned|thinks)\s+.+?)\s+and that\s+(.+)$/iu,
  );
  if (that) return [that[1]!, `${that[2]} ${that[3]} ${that[4]}`];
  const m = s.match(
    /^((\S+(?:\s+[A-Z][\p{L}'-]+)?)\s+.+?),?\s+and\s+(?:also\s+)?((?:recommended|suggested|advised|offered|said|mentioned|told me|thinks|encouraged)\b.*)$/u,
  );
  if (!m || wordCount(m[1]!) < 3) return [s];
  const subject = /^(she|he|they|[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?)$/u.test(m[2]!) ? m[2]! : 'they';
  return [m[1]!, `${subject} ${m[3]!}`];
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

/**
 * The lines of a note worth classifying: no title, attendee or date lines, no section headings; a
 * Summary section wins over a Transcript; speaker labels are stripped and remembered.
 */
function noteLines(text: string, people: NotePerson[], userNames: string[]): Line[] {
  const all = text.replace(/\r/g, '').replace(/ /g, ' ').split('\n');
  const sectionAt = (re: RegExp) => all.findIndex((l) => re.test(l.trim()));
  const summaryIdx = sectionAt(
    /^#{0,4}\s*(summary|notes|meeting notes|key takeaways|takeaways|highlights)\s*:?\s*$/i,
  );
  const transcriptIdx = sectionAt(/^#{0,4}\s*transcript\s*:?\s*$/i);
  let lines = all;
  if (summaryIdx >= 0 && transcriptIdx > summaryIdx) lines = all.slice(0, transcriptIdx);
  else if (summaryIdx >= 0 && transcriptIdx >= 0 && transcriptIdx < summaryIdx) lines = all.slice(summaryIdx);
  const userSet = new Set(
    userNames
      .flatMap((n) => [n, n.split(/\s+/)[0] ?? ''])
      .map((n) => n.toLowerCase().trim())
      .filter(Boolean),
  );
  const keyForLabel = (label: string): string | undefined => {
    const l = label.toLowerCase();
    for (const p of people) {
      const full = `${p.first} ${p.last ?? ''}`.trim().toLowerCase();
      if (l === full || l === p.first.toLowerCase() || (p.last && l === p.last.toLowerCase())) return p.key;
      if (l.split(/\s+/)[0] === p.first.toLowerCase()) return p.key;
    }
    return undefined;
  };
  const out: Line[] = [];
  let actions = false;
  let first = true;
  const contentLines = lines.filter((l) => l.trim()).length;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const isFirst = first;
    first = false;
    if (SECTION_LINE.test(line)) {
      const name = line
        .replace(/^#+\s*/, '')
        .replace(/:\s*$/, '')
        .trim();
      actions = ACTION_SECTION.test(name);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue;
    if (HEADER_LINE.test(line)) continue;
    if (/^\[?\(?\d{1,2}:\d{2}(:\d{2})?\)?\]?$/.test(line)) continue;
    if (/^(\.{2,}|…)$/.test(line)) continue;
    // a title line: short, no sentence punctuation, and more content below it
    if (isFirst && contentLines > 1 && line.length <= 90 && !/[.!?]$/.test(line) && wordCount(line) <= 10)
      continue;
    const m = line.replace(/^[-*•]\s+/, '').match(SPEAKER);
    if (m && !NON_SPEAKER_LABELS.has(m[1]!.toLowerCase()) && wordCount(m[1]!) <= 4) {
      const label = m[1]!;
      const isUser = userSet.has(label.toLowerCase()) || /^(me|i)$/i.test(label);
      const key = isUser ? undefined : keyForLabel(label);
      out.push({ text: m[2]!.trim(), speaker: isUser ? 'user' : 'counterpart', speakerKey: key, actions });
      continue;
    }
    // "Next steps: send resume" on one line
    const inlineAction = line.match(/^(action items?|next steps?|to-?dos?|follow[- ]?ups?)\s*:\s*(.+)$/i);
    if (inlineAction) {
      out.push({ text: inlineAction[2]!, speaker: undefined, actions: true });
      continue;
    }
    out.push({ text: line, speaker: undefined, actions });
  }
  return out;
}

const SWAP_OBJECT_AFTER =
  /^(to|for|with|at|about|introduce|intro|refer|send|tell|show|help|connect|give|put|let|ping|loop|cc|email|call|text|meet|see|thank|ask|owe|from|on|by|than|and)$/i;
const SWAP: Record<string, string> = {
  i: 'you',
  "i'm": "you're",
  "i'll": "you'll",
  "i'd": "you'd",
  "i've": "you've",
  me: 'you',
  my: 'your',
  mine: 'yours',
  myself: 'yourself',
  we: 'you',
  "we're": "you're",
  "we'll": "you'll",
  "we'd": "you'd",
  "we've": "you've",
  our: 'your',
  ours: 'yours',
  us: 'you',
  your: 'my',
  yours: 'mine',
  yourself: 'myself',
  "you're": "I'm",
  "you'll": "I'll",
  "you'd": "I'd",
  "you've": "I've",
};

/**
 * A line spoken by the counterpart is in their first person ("I can refer you"); turn it into the
 * student's frame ("you can refer me").
 */
function swapPerspective(s: string): string {
  const parts = s.split(/(\s+)/);
  let prev = '';
  let prevOut = '';
  let seen = 0;
  return parts
    .map((t) => {
      if (!t || /^\s+$/.test(t)) return t;
      const m = t.match(/^([("“']*)([A-Za-z’']+)([^A-Za-z’']*)$/);
      if (!m) {
        prev = t.toLowerCase();
        seen++;
        return t;
      }
      const pre = m[1]!;
      const word = m[2]!.replace(/’/g, "'");
      const post = m[3]!;
      const lw = word.toLowerCase();
      let r: string | undefined;
      if (lw === 'you') r = SWAP_OBJECT_AFTER.test(prev) ? 'me' : 'I';
      else if (lw === 'am' && prevOut === 'you') r = 'are';
      else if (lw === 'was' && prevOut === 'you') r = 'were';
      else if (lw === 'are' && prevOut === 'I') r = 'am';
      else if (lw === 'were' && prevOut === 'I') r = 'was';
      else r = SWAP[lw];
      const isFirstWord = seen === 0;
      seen++;
      prev = lw;
      const outWord = r ?? word;
      prevOut = outWord;
      if (r === undefined) return t;
      const cased = /^I\b|^I'/.test(r)
        ? r
        : isFirstWord && /^[A-Z]/.test(word)
          ? r[0]!.toUpperCase() + r.slice(1)
          : r;
      return `${pre}${cased}${post}`;
    })
    .join('');
}

const ADVERBS =
  'also|still|now|recently|just|currently|really|already|previously|usually|often|never|always|actually|mostly|mainly|personally|apparently';
const IRREGULAR: Record<string, string> = {
  is: 'are',
  was: 'were',
  has: 'have',
  does: 'do',
  "isn't": "aren't",
  "wasn't": "weren't",
  "hasn't": "haven't",
  "doesn't": "don't",
  goes: 'go',
};

const COMMON_VERBS_3RD =
  'loves|likes|plays|runs|works|leads|manages|lives|has|is|was|does|enjoys|coaches|volunteers|teaches|writes|mentors|travels|cooks|bakes|hikes|climbs|skis|surfs|swims|reads|owns|speaks|studies|spends|goes|rides|paints|sings|builds|makes|helps|knows|wants|misses|hates|recruits|interviews|hires';

/** "leads" -> "lead", "studies" -> "study", "is" -> "are" (after a new subject "you"). */
function agree(verb: string): string {
  const v = verb.toLowerCase();
  if (IRREGULAR[v]) return IRREGULAR[v]!;
  if (!/^[a-z]+s$/.test(v) || /(ss|us|is)$/.test(v) || v.length <= 3) return verb;
  if (/ies$/.test(v)) return `${v.slice(0, -3)}y`;
  if (/(ches|shes|sses|xes|zes|oes)$/.test(v)) return v.slice(0, -2);
  return v.slice(0, -1);
}

/**
 * Turn a sentence about the counterpart (third person, or their name) into a clause addressed to them:
 * "Priya leads a 6-person team" -> "you lead a 6-person team"; "she's from Houston" -> "you're from Houston".
 */
function toSecondPerson(s: string, names: string[]): string {
  const nameAlt = names
    .filter((n) => n.length >= 2)
    .map(escapeRe)
    .join('|');
  let t = s;
  // possessive name: "Priya's team" -> "your team"
  if (nameAlt)
    t = t.replace(
      new RegExp(`\\b(?:${nameAlt})(?:\\s+(?:${nameAlt}))?['’]s\\b(?!\\s+(?:been|got))`, 'g'),
      'your',
    );
  const subj = nameAlt ? `(?:${nameAlt})(?:\\s+(?:${nameAlt}))?|she|he` : 'she|he';
  t = t.replace(
    new RegExp(
      `(^|[^\\p{L}'’])(${subj})(['’](?:s|d|ll))?(\\s+)((?:(?:${ADVERBS})\\s+)*)([\\p{L}'’]+)`,
      'giu',
    ),
    (_all, lead: string, _who: string, contr: string | undefined, sp: string, advs: string, verb: string) => {
      if (contr) {
        const c = contr.slice(1).toLowerCase();
        if (c === 'd') return `${lead}you'd${sp}${advs}${verb}`;
        if (c === 'll') return `${lead}you'll${sp}${advs}${verb}`;
        const have =
          /^(been|got|gotten|done|worked|had|seen|made|built|led|spent|lived|moved|started|joined)$/i.test(
            verb,
          );
        return `${lead}${have ? "you've" : "you're"}${sp}${advs}${verb}`;
      }
      return `${lead}you${sp}${advs}${agree(verb)}`;
    },
  );
  t = t
    .replace(/\b(his|their)\b/gi, 'your')
    .replace(
      /\bher\b(?=\s+(?:to|about|for|and|that|when|if|at|in|on|with|from|by|after|before|again|too|so|but|or)\b|\s*[,.;!?]|\s*$)/gi,
      'you',
    )
    .replace(/\bher\b/gi, 'your')
    .replace(/\b(him|them)\b/gi, 'you')
    .replace(/\b(herself|himself|themselves)\b/gi, 'yourself')
    .replace(/\bthey\s+(are|were|have|do)\b/gi, 'you $1')
    .replace(/\bthey(['’](?:re|ve|ll|d))/gi, 'you$1')
    .replace(/^they\b/i, 'you')
    .replace(/\byou\s+(is|was|has)\b/gi, (_, v: string) => `you ${IRREGULAR[v.toLowerCase()]}`);
  if (nameAlt) t = t.replace(new RegExp(`\\b(?:${nameAlt})\\b`, 'g'), 'you');
  // "you grew up in Austin and loves bouldering" -> "and love bouldering"
  if (/^you\b/i.test(t))
    t = t.replace(
      new RegExp(`\\b(and|but|or)\\s+(${COMMON_VERBS_3RD})\\b`, 'gi'),
      (_, c: string, v: string) => `${c} ${agree(v)}`,
    );
  return t;
}

const upper1 = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const lowerStart = (s: string) =>
  /^(I|I'm|I'll|I'd|I've)\b/.test(s) ? s : /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
const stripEnd = (s: string) => s.replace(/[\s,;:.!?]+$/, '').trim();

function subClauses(s: string): string[] {
  const parts = s.split(/,\s*(?=(?:but|and|so|though|although|while)\b)|;\s*|\s+-\s+/i).map(stripConnectors);
  return parts.length > 1 ? parts : [];
}

/** Pick the part of a compound sentence that carries the signal ("..., but I'll put in a good word"). */
function focusClause(s: string, re: RegExp): string {
  const parts = s.split(/,\s*(?=(?:but|and|so|though|although|while)\b)|;\s*|\s+-\s+/i);
  if (parts.length < 2) return s;
  const hit = parts.find((p) => re.test(p));
  return hit ? stripConnectors(hit) : s;
}

/** Due-date phrase in a sentence ("by Friday", "tomorrow", "by the early deadline in October"). */
export function extractDueHint(s: string): string | undefined {
  const re = new RegExp(
    `\\b((?:by|before|on|until|due|no later than)\\s+(?:the\\s+)?(?:[a-z]+\\s+){0,3}?(?:${WEEKDAYS}|tomorrow|tonight|today|eod|end of (?:the )?(?:day|week|month)|next week|this week|(?:${MONTHS}|${MONTH_SHORT})\\.?(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?|\\d{1,2}\\/\\d{1,2})|(?:next|this)\\s+(?:${WEEKDAYS}|week|month)|tomorrow|tonight|today|eod|end of (?:the )?(?:day|week|month)|in\\s+(?:a|one|two|three|four|\\d+)\\s+(?:days?|weeks?)|in\\s+(?:${MONTHS}))\\b`,
    'i',
  );
  return s.match(re)?.[0];
}

const COMMIT =
  /^(?:I\s+(?:will|need to|have to|should|must|promised(?: to)?|am going to|plan to|want to|owe|said I'?d|told \w+ I'?d|gotta|have got to|can)|I'll|I'm going to|I'm gonna|I'd better|need to|have to|gotta|remember to|don't forget to|must|todo:?|to-?do:?|follow up)\b/i;
const COMMIT_LEAD =
  /^(?:I\s+(?:will|need to|have to|should|must|promised(?: to)?|am going to|plan to|want to|said I'?d|told \w+ I'?d|gotta|have got to|can)|I'll|I'm going to|I'm gonna|I'd better|need to|have to|gotta|remember to|don't forget to|must|todo:?|to-?do:?)\s*/i;

/** "I'll send my resume by Friday" -> "Send my resume by Friday" */
function actionText(s: string): string {
  return upper1(
    stripEnd(
      s
        .replace(COMMIT_LEAD, '')
        .replace(/^(also|just|then|definitely|probably|still)\s+/i, '')
        .replace(/\s+(?:like|as) (?:you|she|he|they) (?:suggested|said|asked)\b/gi, '')
        .replace(/\band I'll\b/g, 'and')
        .replace(/^I owe (?:him|her|them|you) /i, 'Send '),
    ),
  );
}

/** Cut at a word boundary, never mid-word. */
function truncateWords(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : t.slice(0, max)).replace(/[\s,;:]+$/, '')}…`;
}

export function heuristicNoteExtraction(
  text: string,
  optsOrCounterpart?: string | NoteExtractionOptions,
): NoteExtraction {
  const opts: NoteExtractionOptions =
    typeof optsOrCounterpart === 'string'
      ? { counterpartName: optsOrCounterpart }
      : (optsOrCounterpart ?? {});
  const people: NotePerson[] = opts.people?.length
    ? opts.people
    : opts.counterpartName
      ? [{ key: opts.counterpartName, first: opts.counterpartName }]
      : [];
  const primaryKey = people[0]?.key ?? 'them';
  const lines = noteLines(text, people, opts.userNames ?? []);
  const facts: NoteExtraction['facts'] = [];
  const actionItems: NoteExtraction['actionItems'] = [];
  const offers: string[] = [];
  const hooks: string[] = [];
  const summaryParts: string[] = [];
  const offerEvidence: { key: string; evidence: string }[] = [];
  let warm = 0;
  let cool = 0;
  let lastSubject = primaryKey;
  const pronounOf: { he?: string; she?: string } = {};
  const namesOf = (key: string) => {
    const p = people.find((x) => x.key === key);
    return p ? [p.first, ...(p.last ? [p.last] : [])] : [];
  };
  const allNames = people.flatMap((p) => [p.first, ...(p.last ? [p.last] : [])]).filter((n) => n.length >= 2);
  const nameAlt = allNames.map(escapeRe).join('|');
  const nameSet = new Set(allNames.map((n) => n.toLowerCase()));
  const subjAlt = ['she', 'he', 'they', 'you', ...(nameAlt ? [nameAlt] : [])].join('|');
  const subjPrefix = `(?:(?:${subjAlt})(?:\\s+(?:${nameAlt || 'x^'}))?(?:['’](?:s|d|ll|re))?\\s+)`;
  const counterpartSubject = new RegExp(`^${subjPrefix}`, 'i');
  const reportedAdvice = new RegExp(
    `^${subjPrefix}?(?:also\\s+|really\\s+|strongly\\s+|kept\\s+)?(?:recommended|recommends|recommending|suggested|suggests|advised|advises|told me to|(?:told me|said|says|thinks|feels|believes)(?: that)? I (?:should|need to|must|have to)|said to|wants me to|encouraged me to)\\b\\s*(?:that\\s+)?`,
    'iu',
  );
  const reporting = new RegExp(
    `^${subjPrefix}?(?:also\\s+)?(?:said|says|mentioned|mentions|told me|explained|noted|shared|thinks|believes|feels|pointed out|emphasized|stressed|was saying)\\s+(?:that\\s+)?`,
    'iu',
  );
  const reportedOffer = new RegExp(`\\b(?:${subjAlt}) (?:said|says|mentioned) (?:she|he|they)['’]?d\\b`, 'i');

  const nameOf = (key: string) => people.find((p) => p.key === key)?.first;
  const capitalizeNames = (x: string) =>
    allNames.reduce((acc, n) => acc.replace(new RegExp(`\\b${escapeRe(n)}\\b`, 'gi'), n), x);
  /** Who a sentence is about: the speaker, the first attendee named, or (for a pronoun) the last subject. */
  const aboutOf = (s: string, line: Line): string => {
    if (line.speaker === 'counterpart') return line.speakerKey ?? lastSubject;
    let best: { key: string; at: number } | undefined;
    for (const p of people) {
      for (const n of [p.first, p.last].filter((x): x is string => !!x && x.length >= 2)) {
        const m = s.match(new RegExp(`\\b${escapeRe(n)}\\b`, 'i'));
        if (m?.index !== undefined && (!best || m.index < best.at)) best = { key: p.key, at: m.index };
      }
    }
    if (best) {
      lastSubject = best.key;
      const after = s.slice(best.at);
      if (/\b(he|him|his|he's|he'd)\b/i.test(after)) pronounOf.he = best.key;
      if (/\b(she|her|she's|she'd)\b/i.test(after)) pronounOf.she = best.key;
      return best.key;
    }
    const lead = s.match(/^(she|her|he|his|him)\b/i)?.[1]?.toLowerCase();
    const gendered = lead ? pronounOf[/^(she|her)$/.test(lead) ? 'she' : 'he'] : undefined;
    if (gendered) lastSubject = gendered;
    return lastSubject;
  };

  const pushHook = (clause: string, evidence: string, about: string) => {
    const c = toSecondPerson(stripConnectors(clause), namesOf(about));
    hooks.push(lowerStart(stripEnd(c)));
    pushFact('hook', c, evidence, about, 0.65);
  };
  const pushFact = (type: FactType, clause: string, evidence: string, about: string, confidence: number) => {
    const t = lowerStart(stripEnd(clause).replace(/\s+/g, ' '));
    if (wordCount(t) < 2 || t.length < 8) return;
    if (facts.some((f) => f.text.toLowerCase() === t.toLowerCase())) return;
    facts.push({ about, type, text: t, confidence, evidence });
  };

  for (const line of lines) {
    for (const rawSentence of sentencesOf(line.text, nameSet)) {
      const cleaned = stripConnectors(clean(rawSentence));
      if (!cleaned) continue;
      // what the counterpart said is in their first person; put it in the student's frame
      const s0 = stripConnectors(line.speaker === 'counterpart' ? swapPerspective(cleaned) : cleaned);
      if (wordCount(s0) < 3) continue;
      const evidence = `${upper1(stripEnd(capitalizeNames(cleaned)))}.`;
      if (summaryParts.length < 3 && line.speaker !== 'user' && wordCount(s0) >= 4 && !line.actions) {
        const speakerName =
          line.speaker === 'counterpart' ? nameOf(line.speakerKey ?? primaryKey) : undefined;
        summaryParts.push(speakerName ? `${speakerName} said, "${evidence}"` : evidence);
      }
      if (WARM.test(s0)) warm++;
      if (COOL.test(s0)) cool++;
      const about = aboutOf(s0, line);
      const names = namesOf(about);
      const due = extractDueHint(s0);

      // 1. the student's own promises (and anything under "Action items")
      if (line.speaker === 'user') {
        // "That would be great, I'll email you my resume tomorrow"
        const promise = [s0, ...s0.split(/,\s+/).map(stripConnectors)].find(
          (c) => COMMIT.test(c) || (OFFER_VERB.test(c) && /^I\b|^I'/.test(c)),
        );
        if (promise || line.actions)
          actionItems.push({ owner: 'user', text: actionText(promise ?? s0), dueHint: due, about });
        continue;
      }
      if (line.actions) {
        const labelled = line.speaker === 'counterpart';
        const theirs = labelled || (counterpartSubject.test(s0) && !/^I\b/.test(s0));
        if (theirs && OFFER_VERB.test(s0)) {
          // "Elena: intro to the recruiting coordinator" under Action items
          const bare = labelled && !counterpartSubject.test(s0);
          const clause = bare
            ? /^(intro|introduction|referral)\b/i.test(s0)
              ? `you offered ${/^i/i.test(s0) ? 'an' : 'a'} ${lowerStart(s0)}`
              : `you'll ${lowerStart(s0)}`
            : toSecondPerson(s0, names);
          offers.push(lowerStart(stripEnd(clause)));
          offerEvidence.push({ key: about, evidence });
          pushFact('offer', clause, evidence, about, 0.75);
        } else
          actionItems.push({
            owner: theirs ? 'counterpart' : 'user',
            text: actionText(s0),
            dueHint: due,
            about,
          });
        continue;
      }
      // the counterpart telling the student what to do ("You should apply early") is advice, not a promise
      if (line.speaker === 'counterpart' && /^I\s+(should|need to|have to|must|ought to)\b/.test(s0)) {
        const [head, ...tail] = s0.split(/,\s+/);
        pushFact('advice', head!, evidence, about, 0.7);
        for (const t of tail) if (HOOK.test(t)) pushHook(t, evidence, about);
        continue;
      }
      if (COMMIT.test(s0)) {
        actionItems.push({ owner: 'user', text: actionText(s0), dueHint: due, about });
        continue;
      }
      if (
        /^I\b|^I'/.test(s0) &&
        !/\b(she|he|they|you)\s+(said|mentioned|told|recommended|suggested|offered)\b/i.test(s0)
      )
        continue; // the student describing themselves is not a fact about the counterpart

      // 2. advice reported as a recommendation ("She recommended I apply to the APM program")
      if (reportedAdvice.test(s0)) {
        const frame = s0.match(reportedAdvice)![0];
        let rest = s0.slice(frame.length);
        const modal = frame.match(/\bI (should|need to|must|have to)\s*$/i);
        if (modal) rest = `${modal[0].trim()} ${rest}`;
        else if (/\bto\s*$/i.test(frame)) rest = `I should ${rest}`;
        rest = rest.replace(
          /^I\s+(?!should\b|must\b|need\b|have to\b)([a-z]+)/,
          (_, v: string) => `I should ${v}`,
        );
        if (/^to\s+/i.test(rest)) rest = `I should ${rest.replace(/^to\s+/i, '')}`;
        if (/^me to\s+/i.test(rest)) rest = `I should ${rest.replace(/^me to\s+/i, '')}`;
        pushFact('advice', toSecondPerson(rest, names), evidence, about, 0.7);
        if (due && /\b(apply|submit|send|register|sign up|email|follow up)\b/i.test(rest))
          actionItems.push({
            owner: 'user',
            text: actionText(rest.replace(/^I should\s+/i, '')),
            dueHint: due,
            about,
          });
        continue;
      }

      // 3. their offers (never the student's own "I'll send")
      const isOffer = (c: string) =>
        /\boffered to\b/i.test(c) ||
        (counterpartSubject.test(c) && OFFER_FRAME.test(c) && OFFER_VERB.test(c)) ||
        (/^(?:happy|glad) to\b/i.test(c) && OFFER_VERB.test(c)) ||
        reportedOffer.test(c);
      const offerPart = [s0, ...subClauses(s0)].find(isOffer);
      if (offerPart) {
        let core = (offerPart === s0 ? focusClause(s0, OFFER_VERB) : offerPart)
          .replace(reporting, '')
          .replace(/,?\s*which I (?:need|have) to do\b.*$/i, '');
        core = core.replace(/^(happy|glad) to\b/i, (_, w: string) => `you'd be ${w.toLowerCase()} to`);
        const clause = toSecondPerson(core, names);
        offers.push(lowerStart(stripEnd(clause)));
        offerEvidence.push({ key: about, evidence });
        pushFact('offer', clause, evidence, about, 0.75);
        // "...if I send it over, which I need to do by tomorrow"
        if (due && /\bI\s+(need to|have to|will|should|must|promised)\b|\bI'll\b|\bif I send\b/i.test(s0)) {
          const sendIt = s0.match(
            /\bif I (send|share|email|forward) ([\p{L}' ]+?)(?:\s+over)?(?=\s+(?:which|so|and|by|before)\b|[,.]|$)/iu,
          );
          const obj =
            sendIt && /^it$/i.test(sendIt[2]!)
              ? (s0.match(/\bmy (resume|cv|deck|portfolio)\b/i)?.[0] ?? 'it')
              : sendIt?.[2];
          const to = nameOf(about);
          const text = sendIt
            ? `${upper1(sendIt[1]!.toLowerCase())} ${obj}${to ? ` to ${to}` : ''} ${due}`
            : upper1(stripEnd(cleaned));
          actionItems.push({ owner: 'user', text, dueHint: due, about });
        }
        continue;
      }

      const body = toSecondPerson(s0.replace(reporting, ''), names);
      if (
        PERSONAL.test(s0) &&
        !ROLE_SWITCH.test(s0) &&
        !/\b(hiring|launch|headcount|opening|deadline|posting)\b/i.test(s0)
      ) {
        pushFact('personal', focusClause(body, PERSONAL), evidence, about, 0.55);
        continue;
      }
      if (HOOK.test(s0)) {
        const clause = focusClause(body, HOOK);
        hooks.push(lowerStart(stripEnd(clause)));
        pushFact('hook', clause, evidence, about, 0.65);
        continue;
      }
      if (ROLE_SWITCH.test(s0)) pushFact('role_detail', body, evidence, about, 0.65);
      else if (ADVICE.test(s0))
        pushFact(
          'advice',
          focusClause(body, ADVICE).replace(/^(?:your|the) (?:advice|tip) (?:is|was) to\s+/i, 'I should '),
          evidence,
          about,
          0.7,
        );
      else if (ROLE.test(s0)) pushFact('role_detail', focusClause(body, ROLE), evidence, about, 0.65);
    }
  }

  const summary =
    truncateWords(summaryParts.join(' '), 400) || truncateWords(clean(text.replace(/\s+/g, ' ')), 300);
  const warmth: NoteExtraction['warmth'] = warm > cool + 1 ? 'warm' : cool > warm ? 'cool' : 'neutral';
  const firstOffer = offerEvidence[0];
  const myItems = actionItems.filter((a) => a.owner === 'user');
  const offerer = firstOffer ? nameOf(firstOffer.key) : undefined;
  const suggestedNextStep = firstOffer
    ? `Follow up on ${offerer ? `${offerer}'s` : 'their'} offer: "${truncateWords(firstOffer.evidence, 120)}"`
    : myItems.length
      ? `Do what you promised: ${truncateWords(myItems[0]!.text, 120)}.`
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
