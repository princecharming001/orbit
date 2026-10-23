/**
 * The networking agent's tools (plan 16): goals, the tie score and the student's own rating of it, research
 * dossiers, finding new people, asking for an introduction, replies and booking, autonomy, memory, a pause and what
 * is due. Goals, explain_score, rate_closeness and memory work in local mode too (memory is then kept in this
 * browser); the rest need an Orbit account and say so in plain words (never an error) when there is none.
 */
import type { Goal, GoalKind, MemoryKind, ReplyClass } from '@orbit/core';
import { GOAL_KINDS, newId, REPLY_CLASSES } from '@orbit/core';
import { db } from '../../db/schema';
import { calendarInvitesAvailable, sendCalendarInvite } from '../../engine/calendarInvite';
import { CLOSENESS_LABELS, type Closeness, explainScore, rateCloseness } from '../../engine/closeness';
import {
  archiveGoal,
  GOAL_KIND_LABELS,
  type GoalInput,
  goalLine,
  listGoals,
  MAX_ACTIVE_GOALS,
  refreshGoals,
  saveGoal,
} from '../../engine/goals';
import {
  addLinkedInFound,
  LINKEDIN_FOUND_PREFIX,
  linkedInSearchReady,
  searchLinkedInLive,
} from '../../engine/linkedinSearch';
import { forget, listMemories, MEMORY_KINDS, remember, searchMemories } from '../../engine/memory';
import { AUTONOMY_TEXT, type AutonomyLevel, pauseOutreach, setAutonomy } from '../../engine/outreach';
import { askForIntro, cachedPath } from '../../engine/paths';
import {
  blockingQuestions,
  bookCall,
  draftReply,
  listReplies,
  REPLY_CLASS_LABELS,
} from '../../engine/replies';
import { chooseCandidate, dossierView, getDossier, researchPerson } from '../../engine/research';
import { addSourced, candidateLine, providerNames, searchPeople } from '../../engine/sourcing';
import { callApi, isAccountMode, isServerUser } from '../../integrations/orbitApi';
import { z } from '../../zod';
import type { ResultEnvelope, ToolContext } from '../types';
import { type AnyTool, clip, defineTool, ok, plural, requirePerson, toModel, wrapped } from './_shared';
import { createDrafts } from './drafts';
import { routesToMany } from './read';

const KINDS = GOAL_KINDS as unknown as [GoalKind, ...GoalKind[]];
const MEM_KINDS = MEMORY_KINDS as unknown as [MemoryKind, ...MemoryKind[]];
const REPLY_KINDS = REPLY_CLASSES as unknown as [ReplyClass, ...ReplyClass[]];

/** A row of a `list` card. */
interface Item {
  /** what a tap on the row's checkbox means: a recommendationId for add_sourced, so the card can pick people */
  id?: string;
  /** the Orbit person this row already is, when the student knows them */
  known?: string;
  text: string;
  sub?: string;
  chip?: string;
  href?: string;
  links?: { label: string; url: string }[];
  /** a person's photo (or initials) at the start of the row */
  avatar?: { name: string; src?: string };
}

function list<M>(title: string, items: Item[], forModel: M, summary: string, href?: string): ResultEnvelope {
  return ok('list', { title, items }, forModel, summary, href);
}

/** What an account-only tool says without an account: a friendly line, never an error. */
export function needsAccount(what: string): ResultEnvelope {
  const signIn = isAccountMode();
  const summary = signIn
    ? `${what} needs an Orbit account. Sign in with Google first, under Settings, Account, and then ask again.`
    : `${what} needs an Orbit account, and this copy of Orbit runs only on this device, so it is not available here.`;
  return ok(
    'text',
    { available: false },
    { available: false, reason: signIn ? 'sign_in_with_google_first' : 'not_available_in_this_copy' },
    summary,
    signIn ? '/settings/account' : undefined,
  );
}

function accountReady(ctx: ToolContext): boolean {
  return isServerUser(ctx.user.id);
}

/** The Approve card's reason a risky account tool cannot run yet. */
function accountBlock(ctx: ToolContext): string | undefined {
  if (accountReady(ctx)) return undefined;
  return isAccountMode()
    ? 'This needs an Orbit account. Sign in with Google under Settings, Account first.'
    : 'This needs an Orbit account, which this copy of Orbit does not have.';
}

function goalRef(g: Goal) {
  return {
    id: g.id,
    kind: g.kind,
    kindLabel: GOAL_KIND_LABELS[g.kind],
    title: g.title,
    status: g.status,
    priority: g.priority,
    organizations: g.targets.organizations.slice(0, 8),
    roles: g.targets.roles.slice(0, 8),
    geographies: g.targets.geographies.slice(0, 5),
    dueAt: g.dueAt,
    autonomyLevel: g.autonomyLevel,
    successMetric: g.successMetric,
  };
}

const goalItem = (g: Goal): Item => ({
  text: g.title,
  chip: GOAL_KIND_LABELS[g.kind],
  sub: [
    [...g.targets.organizations, ...g.targets.roles].slice(0, 4).join(', '),
    g.dueAt ? `by ${g.dueAt}` : '',
    g.status === 'paused' ? 'paused' : '',
  ]
    .filter(Boolean)
    .join(' · '),
  href: '/settings/goals',
});

const listField = (what: string) => z.array(z.string().min(1).max(200)).max(20).optional().describe(what);

const goalFields = {
  title: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe("A short name in the student's words, at most 60 characters."),
  organizations: listField('Target companies, funds, labs or schools.'),
  roles: listField('Roles or titles to reach ("PM", "seed investor", "head of operations").'),
  geographies: listField('Places that matter ("New York", "remote").'),
  people: listField('Names of specific people the goal is about.'),
  sector: z
    .string()
    .max(100)
    .optional()
    .describe('The sector or field ("fintech", "climate", "graph learning").'),
  stage: z
    .string()
    .max(60)
    .optional()
    .describe('For fundraising or sales: the stage ("pre-seed", "Series A").'),
  keywords: listField('Other words that describe who fits.'),
  successMetric: z.string().max(200).optional().describe('What done looks like ("8 coffee chats by Dec 1").'),
  dueAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('A deadline as YYYY-MM-DD (an application deadline, a close date).'),
  priority: z.number().int().min(1).max(3).optional().describe('1 is the top priority, 3 the lowest.'),
};

type GoalFields = {
  title?: string;
  organizations?: string[];
  roles?: string[];
  geographies?: string[];
  people?: string[];
  sector?: string;
  stage?: string;
  keywords?: string[];
  successMetric?: string;
  dueAt?: string;
  priority?: number;
};

function goalPatch(i: GoalFields, existing?: Goal): Partial<GoalInput> {
  const criteria = { ...(existing?.criteria ?? {}) };
  if (i.sector) criteria.sector = i.sector;
  if (i.stage) criteria.stage = i.stage;
  if (i.keywords) criteria.keywords = i.keywords;
  const t = existing?.targets;
  return {
    title: i.title,
    targets: {
      organizations: i.organizations ?? t?.organizations ?? [],
      roles: i.roles ?? t?.roles ?? [],
      geographies: i.geographies ?? t?.geographies ?? [],
      people: i.people ?? t?.people ?? [],
    },
    criteria,
    successMetric: i.successMetric,
    dueAt: i.dueAt,
    priority: i.priority as Goal['priority'] | undefined,
  };
}

// ---------- goals ----------

export const setGoalTool = defineTool({
  name: 'set_goal',
  kind: 'write',
  description:
    'Call this when the student asks to track a goal, or says yes after you asked "Want me to track this as a goal?". A goal is what they are working toward: recruiting, fundraising, sales, hiring, advice, cofounder, community or collaboration, with targets (companies, roles, places, people) and criteria. Never call it for a goal you only inferred until the student agreed; then pass their own words as evidence. At most five goals are active.',
  input: z.object({
    kind: z.enum(KINDS).describe('What the goal is for.'),
    ...goalFields,
    evidence: z
      .string()
      .max(400)
      .optional()
      .describe("For a goal you proposed: the student's own words it came from."),
  }),
  capabilities: ['goal_set'],
  progress: 'Saving your goal',
  async execute(input, ctx) {
    const g = await saveGoal(ctx.user, {
      kind: input.kind,
      ...goalPatch(input),
      source: input.evidence ? 'inferred' : 'user',
      evidence: input.evidence,
    });
    const active = (await listGoals(ctx.user.id)).filter((x) => x.status === 'active');
    return list(
      'Your goals',
      active.map(goalItem),
      { goal: goalRef(g), active: active.length, max: MAX_ACTIVE_GOALS },
      `Tracking a new goal: ${goalLine(g)}. You have ${plural(active.length, 'active goal')}.`,
      '/settings/goals',
    );
  },
  toModel,
});

export const listGoalsTool = defineTool({
  name: 'list_goals',
  kind: 'read',
  description:
    'Call this when the student asks what their goals are, what they are working toward, or before you change or archive a goal (to get its id). Returns each goal with its kind, title, targets, deadline and priority.',
  input: z.object({
    includeDone: z.boolean().optional().describe('Also list paused and finished goals.'),
  }),
  capabilities: ['goal_list'],
  progress: 'Reading your goals',
  async execute(input, ctx) {
    await refreshGoals(ctx.user.id).catch(() => undefined);
    const goals = await listGoals(ctx.user.id, { includeDone: input.includeDone });
    if (!goals.length)
      return ok(
        'text',
        { goals: [] },
        { goals: [] },
        'No goals yet. Ask what they are working toward, then track it with set_goal.',
        '/settings/goals',
      );
    return list(
      'Your goals',
      goals.map(goalItem),
      { goals: goals.map(goalRef) },
      `${plural(goals.length, 'goal')}: ${goals.map((g) => g.title).join('; ')}.`,
      '/settings/goals',
    );
  },
  toModel,
});

export const updateGoalTool = defineTool({
  name: 'update_goal',
  kind: 'write',
  description:
    'Call this when the student asks to change a goal: its name, targets, deadline, priority, or to pause or restart it (goalId from list_goals). Lists you pass replace the old ones, so include what should stay.',
  input: z.object({
    goalId: z.string().describe('The goal to change (from list_goals).'),
    kind: z
      .enum(KINDS)
      .optional()
      .describe('A different kind, if the student says it is really about something else.'),
    status: z.enum(['active', 'paused']).optional().describe('Pause a goal, or make it active again.'),
    ...goalFields,
  }),
  capabilities: ['goal_update'],
  progress: 'Updating your goal',
  async execute(input, ctx) {
    const existing = await db.userGoals.get(input.goalId);
    if (!existing || existing.userId !== ctx.user.id || existing.deletedAt)
      throw new Error('Orbit has no goal with that id. List the goals first.');
    const g = await saveGoal(ctx.user, {
      id: existing.id,
      kind: input.kind ?? existing.kind,
      status: input.status,
      ...goalPatch(input, existing),
    });
    return list(
      'Goal updated',
      [goalItem(g)],
      { goal: goalRef(g) },
      `Updated the goal: ${goalLine(g)}.`,
      '/settings/goals',
    );
  },
  toModel,
});

export const archiveGoalTool = defineTool({
  name: 'archive_goal',
  kind: 'write',
  description:
    'Call this when the student says a goal is done, dropped or no longer wanted (goalId from list_goals). It stops steering drafts and searches; its chats and people stay.',
  input: z.object({ goalId: z.string().describe('The goal to archive (from list_goals).') }),
  capabilities: ['goal_archive'],
  progress: 'Archiving the goal',
  async execute(input, ctx) {
    const g = await archiveGoal(ctx.user, input.goalId);
    return ok(
      'text',
      { goal: goalRef(g) },
      { archived: g.id },
      `Archived "${g.title}". Its chats and people stay.`,
      '/settings/goals',
    );
  },
  toModel,
});

// ---------- the tie score ----------

export const explainScoreTool = defineTool({
  name: 'explain_score',
  kind: 'read',
  description:
    'Call this when the student asks how close they are to someone, why a person scores what they do, or why someone counts as a strong or weak tie (personId from search_people). Returns the 0 to 100 score with its band (Faint, Light, Warm, Strong, Close) and the plain sentences behind it, built only from real history.',
  input: z.object({ personId: z.string().describe('The person (from search_people).') }),
  capabilities: ['score_explain'],
  progress: 'Reading how close you are',
  async execute(input, ctx) {
    const person = await requirePerson(ctx, input.personId);
    const r = await explainScore(ctx.user, person.id);
    if (!r.ok) throw new Error(r.message);
    const v = r.view;
    return list(
      `${person.displayName}: ${v.label}`,
      v.explanation.map((t) => ({ text: t })),
      {
        person: person.displayName,
        score: v.score,
        band: v.bandLabel,
        explanation: v.explanation,
        ratedByStudent: v.labelled ? CLOSENESS_LABELS[v.labelled] : undefined,
        modelScore: v.modelScore,
      },
      `${person.displayName} is ${v.label}${v.explanation[0] ? `. ${v.explanation[0]}` : ''}.`,
      `/people/${person.id}`,
    );
  },
  toModel,
});

export const rateClosenessTool = defineTool({
  name: 'rate_closeness',
  kind: 'write',
  description:
    'Call this when the student says how close they really are to someone, or that a closeness score is wrong ("Maya is a close friend", "I barely know Dan"). closeness is 1 (barely know them) to 5 (very close). Their rating is shown instead of the computed score until there is new contact, and it tunes the scores.',
  input: z.object({
    personId: z.string().describe('The person (from search_people).'),
    closeness: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe('1 barely know them, 2 a little, 3 friendly, 4 good friends, 5 very close.'),
  }),
  capabilities: ['score_rate'],
  progress: 'Saving your rating',
  async execute(input, ctx) {
    const person = await requirePerson(ctx, input.personId);
    const c = input.closeness as Closeness;
    const r = await rateCloseness(ctx.user, person.id, c);
    if (!r.ok) throw new Error(r.message);
    return ok(
      'text',
      { person: person.displayName, label: r.view.label },
      { person: person.displayName, closeness: c, shownAs: r.view.label },
      `Saved: ${person.displayName} is "${CLOSENESS_LABELS[c].toLowerCase()}", shown as ${r.view.label}.`,
      `/people/${person.id}`,
    );
  },
  toModel,
});

// ---------- research ----------

function dossierEnvelope(
  ctx: ToolContext,
  name: string,
  personId: string,
  d: Parameters<typeof dossierView>[0],
): ResultEnvelope {
  const v = dossierView(d);
  const link = (ns: number[]) =>
    ns
      .map((n) => v.sources.find((s) => s.n === n))
      .filter((s): s is { n: number; url: string } => !!s?.url)
      .map((s) => ({ label: `[${s.n}]`, url: s.url }));
  const items: Item[] = [
    ...(v.who ? [{ text: v.who, chip: 'Who' }] : []),
    ...(v.now ? [{ text: v.now.text, chip: 'Now', links: link(v.now.sources) }] : []),
    ...v.recently.map((c) => ({ text: c.text, sub: c.date, chip: 'Recently', links: link(c.sources) })),
    ...v.inCommon.map((c) => ({ text: c.text, chip: 'In common', links: link(c.sources) })),
    ...(v.history?.summary ? [{ text: v.history.summary, chip: 'History' }] : []),
    ...v.openers.map((c) => ({ text: c.text, chip: 'Opener', links: link(c.sources) })),
    ...v.careful.map((t) => ({ text: t, chip: 'Careful' })),
  ];
  const w = (t: string | undefined) => wrapped(ctx, 'dossier', t, 400);
  return list(
    `Research on ${name}`,
    items,
    {
      status: v.status,
      confidence: v.confidence,
      who: w(v.who),
      now: w(v.now?.text),
      recently: v.recently.map((c) => ({ text: w(c.text), date: c.date, sources: c.sources })),
      inCommon: v.inCommon.map((c) => ({ text: w(c.text), sources: c.sources })),
      openers: v.openers.map((c) => ({ text: w(c.text), sources: c.sources })),
      careful: v.careful.map((t) => w(t)),
      sources: v.sources.length,
    },
    `Research on ${name} is ${v.status === 'partial' ? 'in, though some sources could not be reached' : 'ready'}: ${v.openers.length ? plural(v.openers.length, 'opener') : 'no openers'}, ${plural(v.sources.length, 'source')}.`,
    `/people/${personId}`,
  );
}

function pendingEnvelope(name: string, personId: string, queued: boolean): ResultEnvelope {
  return ok(
    'text',
    { status: 'pending' },
    { status: 'pending' },
    `${queued ? 'Started researching' : 'Still researching'} ${name}. It takes about a minute; the card on their page fills in when it is done.`,
    `/people/${personId}`,
  );
}

function disambiguation(
  name: string,
  personId: string,
  d: Parameters<typeof dossierView>[0],
): ResultEnvelope {
  const v = dossierView(d);
  return ok(
    'choices',
    {
      options: v.candidates.slice(0, 3).map((c) => ({
        label: clip(c.label, 40) ?? `Person ${c.index + 1}`,
        message: `Research the ${name} who is ${c.label} (candidate ${c.index + 1}).`,
      })),
    },
    {
      status: 'needs_disambiguation',
      candidates: v.candidates.map((c) => ({ index: c.index, who: c.label })),
    },
    `More than one ${name} matches. Ask which one they mean; then call research_person with candidateIndex.`,
    `/people/${personId}`,
  );
}

export const researchPersonTool = defineTool({
  name: 'research_person',
  kind: 'write',
  description:
    'Call this when the student asks to research someone, look them up, find out what they are up to, or get openers before writing to them (personId from search_people). Orbit builds a short cited brief from their messages, LinkedIn and the web: who they are, what they do now, recent items, what you share, and three openers. A fresh brief comes back at once; otherwise it is queued. When two people share the name, ask which one and call again with candidateIndex. Needs an Orbit account.',
  input: z.object({
    personId: z.string().describe('The person to research (from search_people).'),
    refresh: z.boolean().optional().describe('Research again even if a recent brief exists.'),
    candidateIndex: z
      .number()
      .int()
      .min(0)
      .max(9)
      .optional()
      .describe('After a "which one did you mean" answer: the index of the person the student picked.'),
  }),
  capabilities: ['research_person'],
  progress: 'Researching',
  async execute(input, ctx) {
    const person = await requirePerson(ctx, input.personId);
    if (!accountReady(ctx)) return needsAccount('Research');
    const r =
      input.candidateIndex !== undefined
        ? await chooseCandidate(ctx.user, person.id, input.candidateIndex)
        : await researchPerson(ctx.user, person.id, { refresh: input.refresh });
    if (!r.ok) throw new Error(r.message);
    if (r.dossier?.status === 'needs_disambiguation')
      return disambiguation(person.displayName, person.id, r.dossier);
    if (!r.dossier || r.status === 'queued' || r.dossier.status === 'pending')
      return pendingEnvelope(person.displayName, person.id, true);
    if (r.dossier.status === 'failed')
      throw new Error(`Research on ${person.displayName} did not work this time.`);
    return dossierEnvelope(ctx, person.displayName, person.id, r.dossier);
  },
  toModel,
});

export const getDossierTool = defineTool({
  name: 'get_dossier',
  kind: 'read',
  description:
    'Call this when the student asks what Orbit found about someone it already researched, or before drafting a first message to use their openers (personId from search_people). Returns the cited brief if there is one; if there is none, offer research_person. Needs an Orbit account.',
  input: z.object({ personId: z.string().describe('The person (from search_people).') }),
  capabilities: ['research_read'],
  progress: 'Reading the research',
  async execute(input, ctx) {
    const person = await requirePerson(ctx, input.personId);
    if (!accountReady(ctx)) return needsAccount('Research');
    const r = await getDossier(ctx.user, person.id);
    if (!r.ok) throw new Error(r.message);
    if (!r.dossier)
      return ok(
        'text',
        { dossier: null },
        { dossier: null },
        `No research on ${person.displayName} yet. research_person can look them up.`,
        `/people/${person.id}`,
      );
    if (r.dossier.status === 'pending') return pendingEnvelope(person.displayName, person.id, false);
    if (r.dossier.status === 'needs_disambiguation')
      return disambiguation(person.displayName, person.id, r.dossier);
    return dossierEnvelope(ctx, person.displayName, person.id, r.dossier);
  },
  toModel,
});

// ---------- sourcing ----------

export const findPeopleTool = defineTool({
  name: 'find_people',
  kind: 'write',
  description:
    "Call this when the student asks to find new people beyond their network for a purpose: investors, customers, candidates, mentors, alumni, a co-founder or research collaborators. Give the purpose (a goal kind) and what they are looking for; with an Orbit account it searches LinkedIn, Apollo, the web and Semantic Scholar and ranks results by fit, how reachable they are and how likely to reply, with reasons. Without one, it searches LinkedIn from the student's own account when LinkedIn is connected live. Show the top few and offer add_sourced.",
  input: z.object({
    purpose: z.enum(KINDS).describe('What the people are for.'),
    query: z
      .string()
      .max(300)
      .optional()
      .describe('Who, in the student\'s words ("seed investors in climate software").'),
    goalId: z.string().optional().describe('The goal this is for (from list_goals), if there is one.'),
  }),
  capabilities: ['source_find'],
  progress: 'Searching for people',
  async execute(input, ctx) {
    if (!accountReady(ctx)) {
      if (!(await linkedInSearchReady(ctx.user))) return needsAccount('Finding new people');
      return findOnLinkedIn(ctx, input.query, input.purpose);
    }
    const r = await searchPeople(ctx.user, input);
    if (!r.ok) throw new Error(r.message);
    const { results, unconfigured, relaxed } = r.value;
    const top = results.slice(0, 10);
    const quiet = [
      relaxed.length ? `To find more, the search left out ${relaxed.join(', ')}.` : '',
      unconfigured.length
        ? `${providerNames(unconfigured)} ${unconfigured.length === 1 ? 'is' : 'are'} not set up yet.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    return list(
      `People for ${GOAL_KIND_LABELS[input.purpose].toLowerCase()}`,
      top.map((c) => ({
        id: c.id,
        known: c.knownPersonId,
        text: candidateLine(c),
        chip: c.knownPersonId ? 'You know them' : undefined,
        sub: c.reasons.slice(0, 2).join('. '),
        href: c.knownPersonId ? `/people/${c.knownPersonId}` : undefined,
      })),
      {
        results: top.map((c) => ({
          recommendationId: c.id,
          who: wrapped(ctx, 'sourced', candidateLine(c), 200),
          location: c.location,
          reasons: c.reasons.slice(0, 2).map((t) => wrapped(ctx, 'sourced', t, 160)),
          knownPersonId: c.knownPersonId,
          rank: Math.round(c.rank * 100) / 100,
        })),
        more: Math.max(0, results.length - top.length),
      },
      `${results.length ? `Found ${plural(results.length, 'person', 'people')}` : 'No one matched yet'}.${quiet ? ` ${quiet}` : ''}`,
      '/discover?tab=find',
    );
  },
  toModel,
});

/** find_people without an account: the student's own LinkedIn, beyond their connections. */
async function findOnLinkedIn(
  ctx: ToolContext,
  query: string | undefined,
  purpose: GoalKind,
): Promise<ResultEnvelope> {
  const r = await searchLinkedInLive(ctx.user, query || GOAL_KIND_LABELS[purpose]);
  if (!r.ok) throw new Error(r.message);
  const top = r.people.slice(0, 10);
  const degree = (d?: number) => (d === 2 ? '2nd' : d === 3 ? '3rd' : undefined);
  return list(
    `On LinkedIn: ${GOAL_KIND_LABELS[purpose].toLowerCase()}`,
    top.map((p) => ({
      id: p.id,
      known: p.knownPersonId,
      text: p.name,
      chip: p.knownPersonId ? 'You know them' : degree(p.distance),
      sub: [p.headline, p.location].filter(Boolean).join(' · '),
      href: p.knownPersonId ? `/people/${p.knownPersonId}` : undefined,
      links: p.profileUrl ? [{ label: 'LinkedIn', url: p.profileUrl }] : undefined,
      avatar: { name: p.name, src: p.pictureUrl },
    })),
    {
      results: top.map((p) => ({
        recommendationId: p.id,
        who: wrapped(ctx, 'sourced', [p.name, p.headline].filter(Boolean).join(', '), 200),
        location: p.location,
        degree: p.distance,
        knownPersonId: p.knownPersonId,
      })),
      source: 'linkedin',
    },
    top.length
      ? `Found ${plural(top.length, 'person', 'people')} on LinkedIn outside your connections.`
      : 'LinkedIn found no one for that. Try other words: a role, a company or a school.',
  );
}

export const addSourcedTool = defineTool({
  name: 'add_sourced',
  kind: 'write',
  description:
    'Call this after find_people when the student picks people to add (their recommendationIds). Each becomes a person in Orbit with a chat at "to contact" for the goal, and research on them starts. Never add people the student did not pick. With then: "routes" it goes straight on to warm routes to each of them in one card; with then: "drafts" it drafts a message to each. Someone added this way is saved to contact, not someone the student knows.',
  input: z.object({
    recommendationIds: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .describe('The recommendationIds from find_people the student chose.'),
    then: z
      .enum(['routes', 'drafts'])
      .optional()
      .describe(
        'What to do right after adding them: "routes" finds warm routes to each, "drafts" drafts a message to each.',
      ),
  }),
  capabilities: ['source_add', 'source_add_then'],
  progress: 'Adding them',
  async execute(input, ctx) {
    const fromLinkedIn = input.recommendationIds.every((id) => id.startsWith(LINKEDIN_FOUND_PREFIX));
    if (fromLinkedIn) {
      const r = await addLinkedInFound(ctx.user, input.recommendationIds);
      if (!r.ok) throw new Error(r.message);
      if (input.then) return andThen(ctx, input.then, r.people);
      return list(
        'Added',
        r.people.map((p) => ({ text: p.displayName, href: `/people/${p.id}` })),
        { added: r.people.map((p) => ({ personId: p.id, name: p.displayName, chatId: p.chatId })) },
        `Added ${r.people.map((p) => p.displayName).join(', ')}, ready to write to on LinkedIn.`,
        r.people.length === 1 ? `/people/${r.people[0]!.id}` : '/people',
      );
    }
    if (!accountReady(ctx)) return needsAccount('Adding people from a search');
    const r = await addSourced(ctx.user, input.recommendationIds);
    if (!r.ok) throw new Error(r.message);
    if (input.then) return andThen(ctx, input.then, r.people);
    return list(
      'Added',
      r.people.map((p) => ({ text: p.displayName, href: `/people/${p.id}` })),
      { added: r.people.map((p) => ({ personId: p.id, name: p.displayName, chatId: p.chatId })) },
      `Added ${r.people.map((p) => p.displayName).join(', ')}. Research on ${r.people.length === 1 ? 'them' : 'each'} has started.`,
      r.people.length === 1 ? `/people/${r.people[0]!.id}` : '/people',
    );
  },
  toModel,
});

/**
 * The step after adding people from a search, in the same turn: warm routes to each of them in one card, or a draft
 * to each. The card says who was added first, so the add is never silent.
 */
async function andThen(
  ctx: ToolContext,
  then: 'routes' | 'drafts',
  people: { id: string; displayName: string }[],
): Promise<ResultEnvelope> {
  const ids = people.map((p) => p.id);
  const added = `Added ${people.map((p) => p.displayName).join(', ')} to People (saved to contact).`;
  const env =
    then === 'routes' ? await routesToMany(ctx, ids) : await createDrafts.execute({ personIds: ids }, ctx);
  return { ...env, summary: `${added} ${env.summary}` };
}

// ---------- introductions ----------

export const askForIntroTool = defineTool({
  name: 'ask_for_intro',
  kind: 'risky',
  description:
    "Call this when the student wants to ask someone on a route for an introduction (pathId from find_routes, which lists each route's id). Orbit drafts the request to the first person on the route and a short note about the student they can forward unchanged. It only drafts: nothing is sent. Needs the student's approval and an Orbit account.",
  input: z.object({
    pathId: z.string().describe('The route to use (an id from find_routes).'),
    targetPersonId: z
      .string()
      .optional()
      .describe('The person the route leads to, so the route can be found again.'),
  }),
  capabilities: ['intro_ask'],
  progress: 'Drafting the intro request',
  async summarizeIntent(input, ctx) {
    const blocked = accountBlock(ctx);
    const c = cachedPath(input.pathId);
    const introducer = c?.path.names?.[c.path.firstHopId];
    const target = c ? c.path.names?.[c.targetPersonId ?? c.path.nodes.at(-1)!] : undefined;
    return {
      text: `Draft a message asking ${introducer ?? 'the first person on that route'} to introduce you to ${target ?? 'them'}, with a short note they can forward. Nothing is sent; the drafts wait in Drafts.`,
      blockedReason: blocked,
    };
  },
  async execute(input, ctx) {
    if (!accountReady(ctx)) return needsAccount('Asking for an introduction');
    const r = await askForIntro(ctx.user, input.pathId, input.targetPersonId);
    if (!r.ok) throw new Error(r.message);
    return ok(
      'text',
      r,
      { introRequestId: r.introRequestId, draftIds: r.draftIds, sent: false },
      `Drafted the intro request to ${r.introducer} about ${r.target}, plus a note they can forward. Nothing was sent; read it in Drafts.`,
      r.draftIds[0] ? `/inbox?draft=${r.draftIds[0]}` : '/inbox',
    );
  },
  toModel,
});

// ---------- replies ----------

export const listRepliesTool = defineTool({
  name: 'list_replies',
  kind: 'read',
  description:
    'Call this when the student asks who replied, what people said back, or which replies need an answer. Lists replies to their outreach from the last 30 days, newest first, each with what it means (interested, picking a time, a question, a referral, not now, declined and so on). Needs an Orbit account.',
  input: z.object({
    replyClass: z.enum(REPLY_KINDS).optional().describe('Only replies of this kind.'),
  }),
  capabilities: ['replies_list'],
  progress: 'Reading your replies',
  async execute(input, ctx) {
    if (!accountReady(ctx)) return needsAccount('Reading replies');
    const r = await listReplies(ctx.user);
    if (!r.ok) throw new Error(r.message);
    const rows = (
      input.replyClass ? r.replies.filter((x) => x.replyClass === input.replyClass) : r.replies
    ).slice(0, 15);
    return list(
      'Replies',
      rows.map((x) => ({
        text: x.personName,
        chip: REPLY_CLASS_LABELS[x.replyClass],
        sub: clip(x.snippet, 140),
        href: x.personId ? `/people/${x.personId}` : '/inbox?tab=replies',
      })),
      {
        replies: rows.map((x) => ({
          messageId: x.messageId,
          personId: x.personId,
          person: wrapped(ctx, 'reply', x.personName, 80),
          channel: x.channel,
          kind: x.replyClass,
          snippet: wrapped(ctx, 'reply', x.snippet, 300),
          draftId: x.draftId,
          received: x.receivedAt.slice(0, 10),
        })),
      },
      rows.length ? `${plural(rows.length, 'reply', 'replies')}.` : 'No replies in the last 30 days.',
      '/inbox?tab=replies',
    );
  },
  toModel,
});

export const draftReplyTool = defineTool({
  name: 'draft_reply',
  kind: 'write',
  description:
    'Call this when the student asks to answer a reply (messageId from list_replies). Orbit drafts the answer in their voice from the whole thread; when they want to talk it offers free times from their calendar. If a fact is missing the draft asks for it, and it cannot be approved until the student answers. It only drafts. Needs an Orbit account.',
  input: z.object({ messageId: z.string().describe('The reply to answer (from list_replies).') }),
  capabilities: ['replies_draft'],
  progress: 'Drafting a reply',
  async execute(input, ctx) {
    if (!accountReady(ctx)) return needsAccount('Drafting replies');
    const r = await draftReply(ctx.user, input.messageId);
    if (!r.ok) throw new Error(r.message);
    const d = r.draft;
    const open = blockingQuestions(d);
    return ok(
      'text',
      { textToPaste: d.body },
      {
        draftId: d.id,
        channel: d.channel,
        body: wrapped(ctx, 'draft', d.body, 1500),
        needsInput: open,
        status: d.status,
        sent: false,
      },
      open.length
        ? `Drafted a reply, but it needs one answer from you first: ${open[0]}`
        : `Drafted a reply${d.channel === 'linkedin' ? ' for LinkedIn' : ''}. Nothing is sent until you approve it in Drafts, Replies.`,
      '/inbox?tab=replies',
    );
  },
  toModel,
});

export const bookCallTool = defineTool({
  name: 'book_call',
  kind: 'risky',
  description:
    "Call this when the student has agreed a time with someone and wants it on their Google Calendar with an invite sent to the other person (with a Meet link). Give personId (from search_people) and the start time; with an Orbit account, a reply's draftId works too. Orbit creates the calendar event and Google emails the invite. The first time, Google asks the student for calendar access. Needs the student's approval.",
  input: z.object({
    personId: z.string().optional().describe('Who the call is with (from search_people).'),
    draftId: z.string().optional().describe('With an Orbit account: the reply draft the time belongs to.'),
    slotStart: z.string().describe('The start time as an ISO date-time.'),
    minutes: z.number().int().min(10).max(120).optional().describe('How long, in minutes (default 30).'),
    label: z
      .string()
      .max(80)
      .optional()
      .describe('The time as the student reads it ("Tue Oct 21, 10:00 ET").'),
  }),
  capabilities: ['calendar_book'],
  progress: 'Booking the call',
  async summarizeIntent(input, ctx) {
    const when =
      input.label ??
      new Date(input.slotStart).toLocaleString('en-US', { timeZone: ctx.user.timezone || undefined });
    const person = input.personId ? await db.people.get(input.personId) : undefined;
    const minutes = input.minutes ?? 30;
    return {
      text: `Put a ${minutes} minute call${person ? ` with ${person.displayName}` : ''} on your calendar for ${when} and send the invite.`,
      blockedReason: Number.isNaN(Date.parse(input.slotStart))
        ? 'That time is not a date.'
        : accountReady(ctx)
          ? undefined
          : !person
            ? 'Say who the call is with.'
            : !person.primaryEmail
              ? `Orbit has no email address for ${person.firstName}, so Google cannot send them an invite.`
              : !calendarInvitesAvailable(ctx.user)
                ? 'Calendar invites need Google sign-in, which this copy of Orbit does not have.'
                : undefined,
    };
  },
  async execute(input, ctx) {
    if (accountReady(ctx) && input.draftId) {
      const r = await bookCall(ctx.user, input.draftId, input.slotStart);
      if (!r.ok) throw new Error(r.message);
      if (r.consentUrl)
        return ok(
          'text',
          { consentUrl: r.consentUrl },
          { booked: false, needsCalendarPermission: true },
          'Google needs one more permission to add events to your calendar. Open Settings, Account to give it, then ask again.',
          '/settings/account',
        );
      return ok(
        'text',
        { eventId: r.eventId },
        { booked: true, eventId: r.eventId },
        `Booked ${input.label ?? 'the call'} and sent the invite.`,
        '/inbox?tab=replies',
      );
    }
    // this browser: the chat's time is saved, then Google adds the event and emails the invite
    const person = await requirePerson(ctx, input.personId ?? '');
    let chat = await db.chats
      .where('personId')
      .equals(person.id)
      .filter((c) => !['declined', 'archived'].includes(c.stage))
      .first();
    if (!chat) {
      const now = new Date().toISOString();
      chat = {
        id: newId('c'),
        userId: ctx.user.id,
        personId: person.id,
        organizationId: person.currentOrganizationId,
        stage: 'scheduling',
        stageEnteredAt: now,
        source: 'manual',
        goalTags: [],
        bumpCount: 0,
        priority: 2,
        createdAt: now,
        updatedAt: now,
      };
      await db.chats.add(chat);
    }
    const r = await sendCalendarInvite(ctx.user, chat, {
      at: new Date(input.slotStart),
      minutes: input.minutes ?? 30,
    });
    if (!r.ok) throw new Error(r.message);
    return ok(
      'text',
      { eventId: r.event.id, meetUrl: r.meetUrl },
      { booked: true, eventId: r.event.id, meetUrl: r.meetUrl, demo: r.demo },
      `Booked ${input.label ?? 'the call'} with ${person.firstName}: it is on your calendar and Google sent the invite${r.meetUrl ? ' with a Meet link' : ''}.`,
      `/people/${person.id}`,
    );
  },
  toModel,
});

// ---------- autonomy, pause, due ----------

export const setAutonomyTool = defineTool({
  name: 'set_autonomy',
  kind: 'risky',
  description:
    'Call this when the student asks to change how much Orbit may do on its own: 0 draft only (the default), 1 send after they approve each message, 2 also send simple replies for them inside two-way email threads (confirming a time, thanks). Optionally for one goal only (goalId from list_goals). LinkedIn and first messages always wait for the student. Needs their approval and an Orbit account.',
  input: z.object({
    level: z
      .number()
      .int()
      .min(0)
      .max(2)
      .describe('0 draft only, 1 send after approval, 2 send simple replies within the rules.'),
    goalId: z.string().optional().describe('Only for this goal (from list_goals).'),
  }),
  capabilities: ['autonomy_set'],
  progress: 'Changing what Orbit may do',
  async summarizeIntent(input, ctx) {
    const l = input.level as AutonomyLevel;
    const goal = input.goalId ? await db.userGoals.get(input.goalId) : undefined;
    return {
      text: `${goal ? `For "${goal.title}": ` : ''}${AUTONOMY_TEXT[l].title}. ${AUTONOMY_TEXT[l].body}`,
      blockedReason: accountBlock(ctx),
    };
  },
  async execute(input, ctx) {
    if (!accountReady(ctx)) return needsAccount('Changing what Orbit may send');
    const l = input.level as AutonomyLevel;
    const r = await setAutonomy(ctx.user, l, input.goalId);
    if (!r.ok) throw new Error(r.message);
    return ok(
      'settings',
      {
        changes: [
          { label: r.goal ? `Autonomy for ${r.goal.title}` : 'Autonomy', to: AUTONOMY_TEXT[l].title },
        ],
      },
      { level: l, goalId: input.goalId },
      `${r.goal ? `For "${r.goal.title}", ` : ''}Orbit is now on "${AUTONOMY_TEXT[l].title}". ${AUTONOMY_TEXT[l].body}`,
      '/settings/outreach',
    );
  },
  toModel,
});

export const pauseOutreachTool = defineTool({
  name: 'pause_outreach',
  kind: 'write',
  description:
    'Call this when the student asks to pause outreach, go quiet for a while (exams, vacation), or to resume. Until the date nothing is drafted or sent for them. Leave until out to resume now. Needs an Orbit account.',
  input: z.object({
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('The last day of the pause as YYYY-MM-DD; leave out to resume.'),
  }),
  capabilities: ['outreach_pause'],
  progress: 'Pausing outreach',
  async execute(input, ctx) {
    if (!accountReady(ctx)) return needsAccount('Pausing outreach');
    const r = await pauseOutreach(ctx.user, input.until ?? null);
    if (!r.ok) throw new Error(r.message);
    return ok(
      'settings',
      { changes: [{ label: 'Outreach paused until', to: r.until ?? 'resumed' }] },
      { quietUntil: r.until },
      r.until
        ? `Outreach is paused until ${r.until}. Nothing is drafted or sent until then.`
        : 'Outreach is back on.',
      '/settings/outreach',
    );
  },
  toModel,
});

const DUE_LABELS: Record<string, string> = {
  bump: 'Follow-up',
  went_quiet: 'Went quiet',
  thank_you: 'Thank-you',
  stage_timer: 'Closing out',
  nurture: 'Keep in touch',
  send_due: 'Sending',
};

export const listDueTool = defineTool({
  name: 'list_due',
  kind: 'read',
  description:
    'Call this when the student asks what is coming up, which follow-ups are due, who to check in with, or what Orbit plans to send. Lists the follow-ups, thank-yous, check-ins and approved sends that are due, each with its reason. Needs an Orbit account; without one, get_today_brief covers it.',
  input: z.object({}),
  capabilities: ['cadence_due'],
  progress: 'Checking what is due',
  async execute(_input, ctx) {
    if (!accountReady(ctx)) return needsAccount('The follow-up schedule');
    const r = await callApi('/cadence/due', {});
    if (!r.ok) throw new Error(r.message);
    const items = r.value.items.slice(0, 15);
    const names = new Map(
      (await db.people.bulkGet(items.map((i) => i.personId).filter((x): x is string => !!x)))
        .filter((p) => !!p)
        .map((p) => [p!.id, p!.displayName]),
    );
    return list(
      'Due',
      items.map((i) => ({
        text: i.personId ? (names.get(i.personId) ?? 'Someone') : (DUE_LABELS[i.kind] ?? 'Due'),
        chip: DUE_LABELS[i.kind] ?? 'Due',
        sub: clip(i.reason, 140),
        href: i.draftId ? `/inbox?draft=${i.draftId}` : i.personId ? `/people/${i.personId}` : undefined,
      })),
      {
        items: items.map((i) => ({
          kind: i.kind,
          personId: i.personId,
          person: i.personId ? names.get(i.personId) : undefined,
          draftId: i.draftId,
          reason: wrapped(ctx, 'due', i.reason, 200),
          due: i.dueAt.slice(0, 10),
        })),
      },
      items.length ? `${plural(items.length, 'thing')} due.` : 'Nothing is due right now.',
      '/inbox',
    );
  },
  toModel,
});

// ---------- memory ----------

export const rememberTool = defineTool({
  name: 'remember',
  kind: 'write',
  description:
    'Call this when the student states a durable preference, constraint, goal detail or outcome worth keeping for later chats ("I prefer morning calls", "our traction is 40 paying clinics", "Maya offered to refer me in March"), or asks you to remember something. Write it in third person about the student, at most 200 characters. Never save health, religion, politics, sexuality, family or other sensitive details unless the student explicitly asked you to remember that. Kept on their Orbit account when signed in, else in this browser.',
  input: z.object({
    text: z.string().min(1).max(300).describe('What to remember, in third person ("Prefers morning calls").'),
    kind: z.enum(MEM_KINDS).describe('preference, constraint, goal_detail, outcome, person_fact or note.'),
    personId: z.string().optional().describe('The person it is about, if any (from search_people).'),
  }),
  capabilities: ['memory_remember'],
  progress: 'Saving to memory',
  async execute(input, ctx) {
    if (input.personId) await requirePerson(ctx, input.personId);
    const r = await remember(ctx.user, input);
    if (!r.ok) throw new Error(r.message);
    return ok(
      'text',
      { memory: r.memory },
      { memoryId: r.memory.id, deduped: r.deduped },
      r.deduped ? 'Already in memory; refreshed it.' : 'Saved to memory.',
      '/settings/memory',
    );
  },
  toModel,
});

export const recallTool = defineTool({
  name: 'recall',
  kind: 'read',
  description:
    'Call this when you need what the student told Orbit before and it is not in the Remembered context: their preferences, constraints, goal details, or what they said about a person. Search with a few words; optionally for one person.',
  input: z.object({
    query: z.string().min(1).max(300).describe('What to look for, in a few words.'),
    personId: z.string().optional().describe('Only memories about this person.'),
  }),
  capabilities: ['memory_recall'],
  progress: 'Checking memory',
  async execute(input, ctx) {
    const r = await searchMemories(ctx.user, input.query, { personId: input.personId, limit: 8 });
    if (!r.ok) throw new Error(r.message);
    return list(
      'From memory',
      r.memories.map((m) => ({ text: m.text, href: '/settings/memory' })),
      { memories: r.memories.map((m) => ({ id: m.id, kind: m.kind, text: m.text, personId: m.personId })) },
      r.memories.length
        ? `${plural(r.memories.length, 'memory', 'memories')} found.`
        : 'Nothing in memory about that.',
      '/settings/memory',
    );
  },
  toModel,
});

export const forgetTool = defineTool({
  name: 'forget',
  kind: 'risky',
  description:
    "Call this when the student asks Orbit to forget something it remembered (memoryId from recall), or everything it remembers about a person (personId). Deleted memories are gone for good. Needs the student's approval.",
  input: z.object({
    memoryId: z.string().optional().describe('One memory to delete (from recall).'),
    personId: z.string().optional().describe('Delete every memory about this person.'),
  }),
  capabilities: ['memory_forget'],
  progress: 'Deleting from memory',
  async summarizeIntent(input) {
    const who = input.personId ? (await db.people.get(input.personId))?.displayName : undefined;
    return {
      text: input.personId
        ? `Delete everything Orbit remembers about ${who ?? 'that person'}. This cannot be undone.`
        : 'Delete that memory. This cannot be undone.',
      blockedReason: !input.memoryId && !input.personId ? 'Say which memory or which person.' : undefined,
    };
  },
  async execute(input, ctx) {
    let ids: string[] = [];
    if (input.memoryId) ids = [input.memoryId];
    else if (input.personId) {
      const all = await listMemories(ctx.user);
      if (!all.ok) throw new Error(all.message);
      ids = all.memories.filter((m) => m.personId === input.personId).map((m) => m.id);
    } else throw new Error('Say which memory or which person to forget.');
    let n = 0;
    for (const id of ids) {
      const r = await forget(ctx.user, id);
      if (!r.ok) throw new Error(r.message);
      n++;
    }
    return ok(
      'text',
      { deleted: n },
      { deleted: n },
      n ? `Deleted ${plural(n, 'memory', 'memories')}.` : 'There was nothing in memory about that.',
      '/settings/memory',
    );
  },
  toModel,
});

export const networkTools: AnyTool[] = [
  setGoalTool,
  listGoalsTool,
  updateGoalTool,
  archiveGoalTool,
  explainScoreTool,
  rateClosenessTool,
  researchPersonTool,
  getDossierTool,
  findPeopleTool,
  addSourcedTool,
  askForIntroTool,
  listRepliesTool,
  draftReplyTool,
  bookCallTool,
  setAutonomyTool,
  pauseOutreachTool,
  listDueTool,
  rememberTool,
  recallTool,
  forgetTool,
];
