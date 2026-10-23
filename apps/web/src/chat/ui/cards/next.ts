/**
 * The next steps a card offers, as chips. Each step's message is a sentence the no-key router turns into a tool call
 * (router.ts and its tests) and a model reads as a plain request, so a chip works the same with or without a Claude
 * key. Kept apart from the cards so the phrasing can be tested against the router.
 */
import type { NextStep } from './parts';

/** How a kind of message is said in a request the router understands ("Draft a thank you to ..."). */
const KIND_PHRASE: Record<string, string> = {
  thank_you: 'thank you',
  bump: 'follow up',
  nurture: 'check in',
  schedule: 'scheduling message',
  reply: 'reply',
  congratulate: 'congratulations note',
  referral_ask: 'referral ask',
  report_back: 'report back',
};

/** The chip's words for writing a kind of message to someone. */
function writeLabel(first: string, kind?: string): string {
  switch (kind) {
    case 'thank_you':
      return `Thank ${first}`;
    case 'bump':
      return `Follow up with ${first}`;
    case 'nurture':
      return `Check in with ${first}`;
    case 'schedule':
      return `Propose times to ${first}`;
    case 'reply':
      return `Reply to ${first}`;
    case 'congratulate':
      return `Congratulate ${first}`;
    case 'referral_ask':
      return `Ask ${first} for a referral`;
    case 'report_back':
      return `Report back to ${first}`;
    default:
      return `Write to ${first}`;
  }
}

const firstOf = (name: string) => name.split(' ')[0] ?? name;

/**
 * "Thank Lena": a draft of that kind. Without a kind (or for a first message) it is "Write to Lena", and Orbit picks
 * the kind from where the chat stands.
 */
export function writeTo(name: string, kind?: string): NextStep {
  const phrase = kind ? KIND_PHRASE[kind] : undefined;
  return {
    label: writeLabel(firstOf(name), phrase ? kind : undefined),
    message: phrase ? `Draft a ${phrase} to ${name}` : `Write to ${name}`,
  };
}

/** "A, B and C" */
export function nameList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The most a next step drafts at once: the rows a folded list shows. */
const EACH_MAX = 5;

/**
 * One draft per person, at once (the router's batch phrase and the create_drafts tool), for the first five: a plain
 * "message" lets Orbit pick each kind from where that chat stands.
 */
export function writeToEach(names: string[], kind?: string): NextStep | undefined {
  const all = [...new Set(names)];
  const list = all.slice(0, EACH_MAX);
  if (list.length < 2) return list[0] ? writeTo(list[0], kind) : undefined;
  const phrase = (kind && KIND_PHRASE[kind]) ?? 'message';
  const who =
    all.length > list.length ? `the top ${list.length}` : list.length === 2 ? 'both' : `all ${list.length}`;
  return {
    label: kind === 'bump' ? `Follow up with ${who}` : `Draft a message to ${who}`,
    message: `Draft a ${phrase} to each of: ${nameList(list)}`,
  };
}

/** The way a picked row is named in a message: the name, with its recommendationId when it is not in Orbit yet. */
export interface Picked {
  name: string;
  /** a recommendationId from find_people, for someone not in Orbit yet */
  rec?: string;
}

const pickedList = (rows: Picked[]) =>
  nameList(rows.map((r) => (r.rec ? `${r.name} [rec ${r.rec}]` : r.name)));

/** "Find warm routes to each of: A and B": one card with the best way in to each (people Orbit has). */
export function routesToEach(names: string[]): NextStep | undefined {
  const list = [...new Set(names)].slice(0, 10);
  if (!list.length) return undefined;
  if (list.length === 1) return { label: 'Find warm routes', message: `Who can introduce me to ${list[0]}` };
  return { label: 'Find warm routes', message: `Find warm routes to each of: ${nameList(list)}` };
}

/** "Add to People: A [rec x] and B [rec y]", then routes to each or a draft to each, in the same turn. */
export function addPicked(rows: Picked[], then?: 'routes' | 'drafts'): NextStep | undefined {
  const list = rows.slice(0, 20);
  if (!list.length) return undefined;
  const head =
    then === 'routes'
      ? 'Add to People and find warm routes to each of'
      : then === 'drafts'
        ? 'Add to People and draft a message to each of'
        : 'Add to People';
  return {
    label: then === 'routes' ? 'Find warm routes' : then === 'drafts' ? 'Write to them' : 'Add to People',
    message: `${head}: ${pickedList(list)}`,
  };
}

export const prepFor = (name: string): NextStep => ({
  label: 'Prep for the chat',
  message: `Prep me for my chat with ${name}`,
});

export const introTo = (name: string): NextStep => ({
  label: 'Find a warm intro',
  message: `Who can introduce me to ${name}`,
});

export const whoKnows = (name: string): NextStep => ({
  label: `Who ${firstOf(name)} knows`,
  message: `Who does ${name} know`,
});

export const askForIntro = (introducer: string, target: string): NextStep => ({
  label: `Ask ${firstOf(introducer)} for an intro`,
  message: `Draft an intro request to ${introducer} for ${target}`,
});

export const addTarget = (company: string): NextStep => ({
  label: `Add ${company} to targets`,
  message: `Add ${company} to my target companies`,
});

export const whoWentQuiet: NextStep = { label: 'Who went quiet', message: 'Who went quiet?' };
export const showDrafts: NextStep = { label: 'Show my drafts', message: 'Show my drafts' };

export const warmUpFirst = (name: string): NextStep => ({
  label: 'Warm up first',
  message: `Warm up ${name} first`,
});

export const writeNow = (name: string): NextStep => ({
  label: 'Write now',
  message: `Write to ${name} now, skip the warm-up`,
});

/** The next step after a chat moved to a stage. */
export function afterStage(name: string, stage?: string): NextStep | undefined {
  switch (stage) {
    case 'replied':
    case 'scheduling':
      return writeTo(name, 'schedule');
    case 'scheduled':
      return prepFor(name);
    case 'completed':
      return writeTo(name, 'thank_you');
    case 'no_response':
      return writeTo(name, 'bump');
    case 'identified':
      return writeTo(name);
    default:
      return undefined;
  }
}
