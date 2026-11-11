/**
 * The next steps a card offers, as chips. Each step's message is a sentence the no-key router turns into a tool call
 * (router.ts and its tests) and a model reads as a plain request, so a chip works the same with or without a Claude
 * key. Kept apart from the cards so the phrasing can be tested against the router.
 */
import type { StepRun } from '../../types';
import type { NextStep } from './parts';

/**
 * A step that runs in place and shows its result in the side panel (a draft to edit, the routes to someone): the tap
 * adds nothing to the thread. Built only when the card knows who it is about by id; by name alone, the step is the
 * message, as before.
 */
const inPanel = (tool: string, input: Record<string, unknown>, done: string): StepRun => ({
  tool,
  input,
  done,
  show: 'panel',
});

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
export function writeTo(name: string, kind?: string, personId?: string): NextStep {
  const phrase = kind ? KIND_PHRASE[kind] : undefined;
  return {
    label: writeLabel(firstOf(name), phrase ? kind : undefined),
    message: phrase ? `Draft a ${phrase} to ${name}` : `Write to ${name}`,
    ...(personId
      ? {
          run: inPanel(
            'create_draft',
            { personId, ...(phrase ? { kind } : {}) },
            `Draft to ${firstOf(name)}`,
          ),
        }
      : {}),
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
export function writeToEach(names: string[], kind?: string, personIds?: string[]): NextStep | undefined {
  const all = [...new Set(names)];
  const list = all.slice(0, EACH_MAX);
  // the ids line up with the names when the card knows everyone by id
  const ids =
    personIds && personIds.length === names.length ? [...new Set(personIds)].slice(0, EACH_MAX) : undefined;
  if (list.length < 2) return list[0] ? writeTo(list[0], kind, ids?.[0]) : undefined;
  const phrase = (kind && KIND_PHRASE[kind]) ?? 'message';
  const who =
    all.length > list.length ? `the top ${list.length}` : list.length === 2 ? 'both' : `all ${list.length}`;
  return {
    label: kind === 'bump' ? `Follow up with ${who}` : `Draft a message to ${who}`,
    message: `Draft a ${phrase} to each of: ${nameList(list)}`,
    ...(ids && ids.length === list.length
      ? {
          run: inPanel(
            'create_drafts',
            { personIds: ids, ...(kind && KIND_PHRASE[kind] ? { kind } : {}) },
            `${ids.length} drafts`,
          ),
        }
      : {}),
  };
}

/** The way a picked row is named in a message: the name, with its recommendationId when it is not in Orbit yet. */
export interface Picked {
  name: string;
  /** a recommendationId from find_people, for someone not in Orbit yet */
  rec?: string;
  /** the Orbit person, for someone already in People */
  id?: string;
}

/** A message as the student reads it: the "[rec …]" ids a picked row carries for the tools are left out. */
export const withoutRefs = (text: string) =>
  text
    .replace(/\s*\[rec [^\]]*(?:\]|…?$)/g, '')
    // a pick from a question back (plan 37): the student sees the name they tapped
    .replace(/\s*\[picked (?:company|person|draft) [^\]]*(?:\]|…?$)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

const pickedList = (rows: Picked[]) =>
  nameList(rows.map((r) => (r.rec ? `${r.name} [rec ${r.rec}]` : r.name)));

/** "Find warm routes to each of: A and B": one card with the best way in to each (people Orbit has). */
export function routesToEach(names: string[], personIds?: string[]): NextStep | undefined {
  const list = [...new Set(names)].slice(0, 10);
  if (!list.length) return undefined;
  const ids =
    personIds && personIds.length === names.length ? [...new Set(personIds)].slice(0, 10) : undefined;
  if (list.length === 1)
    return {
      label: 'Find warm routes',
      message: `Who can introduce me to ${list[0]}`,
      ...(ids?.[0]
        ? { run: inPanel('find_routes', { personId: ids[0] }, `Routes to ${firstOf(list[0]!)}`) }
        : {}),
    };
  return {
    label: 'Find warm routes',
    message: `Find warm routes to each of: ${nameList(list)}`,
    ...(ids && ids.length === list.length
      ? { run: inPanel('find_routes', { personIds: ids }, `Routes to ${ids.length} people`) }
      : {}),
  };
}

/**
 * "Add to People: A [rec x] and B [rec y]", then routes to each or a draft to each, in the same turn. Pressing it is
 * the student's choice to add the people not in Orbit yet, so the label says Add whenever someone new would join.
 */
export function addPicked(rows: Picked[], then?: 'routes' | 'drafts'): NextStep | undefined {
  const list = rows.slice(0, 20);
  if (!list.length) return undefined;
  const adds = list.some((r) => r.rec);
  // everyone picked is in Orbit already: there is no one to add
  if (!then && !adds) return undefined;
  const head =
    then === 'routes'
      ? 'Add to People and find warm routes to each of'
      : then === 'drafts'
        ? 'Add to People and draft a message to each of'
        : 'Add to People';
  const label =
    then === 'routes'
      ? adds
        ? 'Add and find routes'
        : 'Find warm routes'
      : then === 'drafts'
        ? adds
          ? 'Add and write to them'
          : 'Write to them'
        : 'Add to People';
  const message = `${head}: ${pickedList(list)}`;
  // adding alone acts in place (plan 37 §4): the people join, the chip says so, nothing is said in the thread
  const recs = list.flatMap((r) => (r.rec ? [r.rec] : []));
  if (!then && recs.length)
    return {
      label,
      message,
      run: { tool: 'add_sourced', input: { recommendationIds: recs }, done: 'Added to People' },
    };
  // routes or a draft to each: everyone new is added and the card opens in the side panel, when the card knows
  // each row (new by its recommendation, already in People by id)
  const ids = list.flatMap((r) => (!r.rec && r.id ? [r.id] : []));
  const n = list.length;
  if (then && recs.length === n)
    return {
      label,
      message,
      run: inPanel(
        'add_sourced',
        { recommendationIds: recs, next: then },
        then === 'routes'
          ? `Added, routes to ${n === 1 ? firstOf(list[0]!.name) : `${n} people`}`
          : `Added, ${n === 1 ? 'a draft' : `${n} drafts`}`,
      ),
    };
  if (then && ids.length === n)
    return then === 'routes'
      ? {
          ...routesToEach(
            list.map((r) => r.name),
            ids,
          )!,
          label,
          message,
        }
      : {
          ...writeToEach(
            list.map((r) => r.name),
            undefined,
            ids,
          )!,
          label,
          message,
        };
  return { label, message };
}

/** Prep opens the person's prep deck in the side panel, when the card knows who it is by id. */
export const prepFor = (name: string, personId?: string): NextStep => ({
  label: 'Prep for the chat',
  message: `Prep me for my chat with ${name}`,
  ...(personId ? { open: `/people/${personId}?prep=1` } : {}),
});

export const introTo = (name: string, personId?: string): NextStep => ({
  label: 'Find a warm intro',
  message: `Who can introduce me to ${name}`,
  ...(personId ? { run: inPanel('find_routes', { personId }, `Routes to ${firstOf(name)}`) } : {}),
});

export const whoKnows = (name: string): NextStep => ({
  label: `Who ${firstOf(name)} knows`,
  message: `Who does ${name} know`,
});

export const askForIntro = (
  introducer: string,
  target: string,
  introducerId?: string,
  targetId?: string,
): NextStep => ({
  label: `Ask ${firstOf(introducer)} for an intro`,
  message: `Draft an intro request to ${introducer} for ${target}`,
  ...(introducerId && targetId
    ? {
        run: inPanel(
          'create_draft',
          { personId: introducerId, kind: 'intro_request', targetPersonId: targetId },
          `Intro ask to ${firstOf(introducer)}`,
        ),
      }
    : {}),
});

/** Acts in place (plan 37 §4): the company goes on the targets, the chip says so, the thread stays as it was. */
export const addTarget = (company: string): NextStep => ({
  label: `Add ${company} to targets`,
  message: `Add ${company} to my target companies`,
  run: { tool: 'manage_target_company', input: { action: 'add', names: company }, done: 'Added to targets' },
});

export const whoWentQuiet: NextStep = { label: 'Who went quiet', message: 'Who went quiet?' };
export const showDrafts: NextStep = { label: 'Show my drafts', message: 'Show my drafts' };

export const warmUpFirst = (name: string, personId?: string): NextStep => ({
  label: 'Warm up first',
  message: `Warm up ${name} first`,
  ...(personId
    ? { run: inPanel('create_draft', { personId, warmUp: 'start' }, `Warm-up for ${firstOf(name)}`) }
    : {}),
});

export const writeNow = (name: string, personId?: string): NextStep => ({
  label: 'Write now',
  message: `Write to ${name} now, skip the warm-up`,
  ...(personId
    ? { run: inPanel('create_draft', { personId, warmUp: 'skip' }, `Draft to ${firstOf(name)}`) }
    : {}),
});

/** The next step after a chat moved to a stage. */
export function afterStage(name: string, stage?: string, personId?: string): NextStep | undefined {
  switch (stage) {
    case 'replied':
    case 'scheduling':
      return writeTo(name, 'schedule', personId);
    case 'scheduled':
      return prepFor(name, personId);
    case 'completed':
      return writeTo(name, 'thank_you', personId);
    case 'no_response':
      return writeTo(name, 'bump', personId);
    case 'identified':
      return writeTo(name, undefined, personId);
    default:
      return undefined;
  }
}
