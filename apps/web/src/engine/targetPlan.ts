/**
 * Paste a job link, get the plan (plan 23 §4.1). From a posting (or a company alone), Orbit picks up to three people
 * who can get the student in, one per role: someone who recruits for it, someone on the team, and someone who leads
 * it. Each comes with the way in the Map shows (the student's own tie, a warm route through someone, or cold), a day
 * (the strongest direct tie today, a warm intro ask two days on, the person who leads the team after the first one
 * replies) and the draft that fits the route. Nothing is drafted until the student says so, and nothing is sent
 * without their approval.
 *
 * The picking is pure (`planPicks`), over the company list the company page shows (engine/graph.ts companyPeople), so
 * the simulation runs it over hundreds of made-up networks. The plan is kept in this browser (db.targetPlans).
 */
import {
  type CoffeeChat,
  functionOf,
  normalizeCompany,
  type PostingInfo,
  type ReachHop,
  seniorityClass,
  type TargetCompany,
  type TargetPlan,
  type TargetPlanStep,
  type User,
} from '@orbit/core';
import { db } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { linkIn, postingFromText, readPosting } from '../integrations/postings';
import { startWarmUpOrOutreach, upsertSuggestions } from './brief';
import { requestIntro } from './drafts';
import { budgetLeft, readBudget, spend } from './enrichment/store';
import { type CompanyPerson, type CompanyTeam, reachCompany, teamOf } from './graph';
import { addLinkedInFound, type FoundView, linkedInSearchReady, searchLinkedInLive } from './linkedinSearch';
import { addTarget } from './targets';

const DAY = 86_400_000;
/** Stages that mean the student is already talking with them: shown as "already in your pipeline", never redrafted. */
const LIVE_STAGES = new Set<CoffeeChat['stage']>([
  'warming',
  'outreach_sent',
  'replied',
  'scheduling',
  'scheduled',
  'completed',
  'followed_up',
  'nurturing',
]);

export interface PlanInput {
  people: CompanyPerson[];
  chats: Pick<CoffeeChat, 'personId' | 'stage' | 'archivedAt' | 'lastInboundAt' | 'updatedAt'>[];
  posting: Pick<PostingInfo, 'role' | 'team' | 'company'> & Partial<Pick<PostingInfo, 'namesOnPage'>>;
  /** people already picked in another plan this week: nobody is picked twice */
  exclude?: ReadonlySet<string>;
  /** with a company and no role: the role the student is going for, to tell who is on the team */
  fitRole?: string;
  now: Date;
  tz?: string;
}

export interface Picks {
  steps: TargetPlanStep[];
  inPipeline: { personId: string; line: string }[];
  /** reachable people left over, for "9 more people you can reach" */
  more: number;
  /** roles nobody in the network fills */
  missing: TargetPlanStep['role'][];
}

/** The function a posting's role works in: "Software Engineer Intern" is engineering. */
export function roleTeam(role: string | undefined): CompanyTeam | undefined {
  const t = teamOf(role);
  return t === 'other' || t === 'leadership' ? (functionOf(role) as CompanyTeam | undefined) : t;
}

const MANAGES = /\b(manager|lead|head|director|vp|vice president)\b/i;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Who could fill each role: recruiters; people on the role's team (up to senior), narrowed to the posting's team when
 * a title names it; people who lead it (senior, or a title that says manager, lead or head); alumni.
 */
export function roleOf(
  c: CompanyPerson,
  posting: PlanInput['posting'],
  fitRole?: string,
): TargetPlanStep['role'][] {
  const out: TargetPlanStep['role'][] = [];
  const title = c.person.currentTitle ?? '';
  const fn = roleTeam(posting.role || fitRole);
  if (c.team === 'recruiting') out.push('recruiter');
  const sameFn = !!fn && (c.team === fn || functionOf(title) === fn);
  const cls = seniorityClass(title);
  if (sameFn && (cls === 1 || cls === 2 || MANAGES.test(title))) out.push('manager');
  if (sameFn && (cls === 0 || cls === 1 || cls === undefined) && !MANAGES.test(title)) out.push('team');
  if (c.alum) out.push('alum');
  return out;
}

/** How well someone fits the team the posting names: a title that says the team first. */
function teamFit(c: CompanyPerson, posting: PlanInput['posting']): number {
  const team = posting.team?.trim().toLowerCase();
  if (!team) return 0;
  const words = team.split(/\s+/).filter((w) => w.length > 2);
  const title = `${c.person.currentTitle ?? ''} ${c.teamName ?? ''}`.toLowerCase();
  return words.some((w) => title.includes(w)) ? 1 : 0;
}

/** "Payments" in "Software Engineer, Payments" or a title that names the posting's team. */
function onTheTeam(c: CompanyPerson, posting: PlanInput['posting']): boolean {
  return teamFit(c, posting) > 0;
}

function roleText(
  role: TargetPlanStep['role'],
  c: CompanyPerson,
  posting: PlanInput['posting'],
  named: boolean,
) {
  const company = posting.company;
  switch (role) {
    case 'recruiter':
      return named ? 'recruits for this posting' : `recruits at ${company}`;
    case 'manager':
      return named
        ? 'the hiring manager'
        : posting.team
          ? `leads on the ${posting.team} team`
          : 'leads the team';
    case 'team':
      return onTheTeam(c, posting) && posting.team ? `on the ${posting.team} team` : 'knows the team';
    case 'alum':
      return c.person.school ? `went to ${c.person.school}` : 'went to your school';
  }
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  // a weekend day moves to Monday: nobody plans a first message for Saturday
  while (x.getDay() === 0 || x.getDay() === 6) x.setDate(x.getDate() + 1);
  return x;
}

function stepRoute(c: CompanyPerson): TargetPlanStep['route'] {
  return {
    kind: c.route.kind,
    viaId: c.route.via?.id,
    score: c.route.score,
    band: c.route.band,
    line: c.route.line,
    hops: c.route.path?.hops.map((h: ReachHop) => ({ ...h })),
  };
}

/** "replied Thu", "chat booked", "you wrote Mon": where the student stands with someone already in the pipeline. */
function pipelineLine(chat: PlanInput['chats'][number], now: Date, tz?: string): string {
  const day = (iso: string) =>
    Math.abs(now.getTime() - Date.parse(iso)) < 6 * DAY
      ? new Date(iso).toLocaleDateString('en-US', { weekday: 'short', timeZone: tz })
      : new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz });
  const when = chat.lastInboundAt ?? chat.updatedAt;
  const what =
    chat.stage === 'scheduled'
      ? 'chat booked'
      : chat.stage === 'completed' || chat.stage === 'followed_up' || chat.stage === 'nurturing'
        ? 'you talked'
        : chat.lastInboundAt
          ? `replied ${day(when)}`
          : chat.stage === 'warming'
            ? 'warming up'
            : `you wrote ${day(chat.updatedAt)}`;
  return `already in your pipeline · ${what}`;
}

/**
 * The picks: one per role (recruiter, team, manager), the best route first and an alum ahead in a tie, never someone
 * who asked not to be contacted, who declined, who is already in the pipeline, or who is in another plan this week.
 * With a role nobody fills, the best remaining person there takes the slot under their own role. Then the days.
 */
export function planPicks(input: PlanInput): Picks {
  const { posting, now } = input;
  const byPerson = new Map<string, PlanInput['chats'][number]>();
  for (const c of input.chats) if (!c.archivedAt) byPerson.set(c.personId, c);
  const inPipeline: Picks['inPipeline'] = [];
  const free: CompanyPerson[] = [];
  for (const c of input.people) {
    if (c.person.doNotContact || c.person.hiddenAt) continue;
    const chat = byPerson.get(c.person.id);
    if (chat?.stage === 'declined') continue;
    if (chat && LIVE_STAGES.has(chat.stage)) {
      inPipeline.push({ personId: c.person.id, line: pipelineLine(chat, now, input.tz) });
      continue;
    }
    if (input.exclude?.has(c.person.id)) continue;
    free.push(c);
  }
  const rank = (a: CompanyPerson, b: CompanyPerson) =>
    teamFit(b, posting) - teamFit(a, posting) ||
    b.route.score - a.route.score ||
    Number(b.alum) - Number(a.alum) ||
    a.person.displayName.localeCompare(b.person.displayName);
  const named = (c: CompanyPerson, list: string[] | undefined) =>
    (list ?? []).some((n) => sameName(n, c.person.displayName));
  const chosen: { c: CompanyPerson; role: TargetPlanStep['role'] }[] = [];
  const taken = new Set<string>();
  const missing: TargetPlanStep['role'][] = [];
  for (const role of ['recruiter', 'team', 'manager'] as const) {
    // a name the posting itself gives wins its role
    const list =
      role === 'recruiter'
        ? posting.namesOnPage?.recruiters
        : role === 'manager'
          ? posting.namesOnPage?.managers
          : undefined;
    const cands = free
      .filter(
        (c) =>
          !taken.has(c.person.id) && (roleOf(c, posting, input.fitRole).includes(role) || named(c, list)),
      )
      .sort((a, b) => Number(named(b, list)) - Number(named(a, list)) || rank(a, b));
    const pick = cands[0];
    if (!pick) {
      missing.push(role);
      continue;
    }
    taken.add(pick.person.id);
    chosen.push({ c: pick, role });
  }
  // a role nobody fills: the best remaining way in takes the slot, alumni first, under what they are
  for (const _ of missing) {
    const pick = free
      .filter((c) => !taken.has(c.person.id) && c.route.kind !== 'cold')
      .sort((a, b) => Number(b.alum) - Number(a.alum) || rank(a, b))[0];
    if (!pick) break;
    taken.add(pick.person.id);
    const r = roleOf(pick, posting, input.fitRole);
    chosen.push({ c: pick, role: pick.alum ? 'alum' : (r[0] ?? 'team') });
  }
  // the days: the strongest direct tie today, a warm ask two days on, the one who leads the team after a reply
  const direct = chosen
    .filter((x) => x.c.route.kind === 'direct')
    .sort((a, b) => b.c.route.score - a.c.route.score);
  const lead =
    direct.find((x) => x.role !== 'manager') ??
    direct[0] ??
    chosen.find((x) => x.c.route.kind === 'warm') ??
    chosen[0];
  const steps: TargetPlanStep[] = chosen.map(({ c, role }) => {
    const isLead = lead?.c.person.id === c.person.id;
    const draft: TargetPlanStep['draft'] =
      c.route.kind === 'warm' ? 'intro_request' : c.route.kind === 'cold' ? 'warm_up' : 'outreach';
    let when: TargetPlanStep['when'];
    if (isLead) when = { kind: 'today', at: now.toISOString() };
    else if (role === 'manager' && lead)
      when = { kind: 'after_reply', at: addDays(now, 5).toISOString(), afterPersonId: lead.c.person.id };
    else if (c.route.kind === 'warm') when = { kind: 'on', at: addDays(now, 2).toISOString() };
    else when = { kind: 'on', at: addDays(now, 1).toISOString() };
    return {
      personId: c.person.id,
      role,
      roleText: roleText(
        role,
        c,
        posting,
        named(c, role === 'recruiter' ? posting.namesOnPage?.recruiters : posting.namesOnPage?.managers),
      ),
      route: stepRoute(c),
      when,
      draft,
      status: when.kind === 'after_reply' ? 'held' : 'proposed',
    };
  });
  // in the order they go out
  const order = (s: TargetPlanStep) => (s.when.kind === 'today' ? 0 : s.when.kind === 'on' ? 1 : 2);
  steps.sort((a, b) => order(a) - order(b) || a.when.at.localeCompare(b.when.at));
  const reachable = free.filter((c) => c.route.kind !== 'cold' && !taken.has(c.person.id)).length;
  return { steps, inPipeline, more: reachable, missing: steps.length >= 3 ? [] : missing };
}

/** "today", "Wed", "after Dana replies": when a step goes, in the plan's words. */
export function whenText(s: TargetPlanStep, nameOf: (id: string) => string, now: Date, tz?: string): string {
  if (s.when.kind === 'today') return 'today';
  if (s.when.kind === 'after_reply') return `after ${nameOf(s.when.afterPersonId ?? '')} replies`;
  const d = new Date(s.when.at);
  const days = Math.round((d.getTime() - now.getTime()) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: tz });
}

/** The posting in one line, as the plan's header and the drafts' reason name it. */
export function postingLine(p: Pick<PostingInfo, 'role' | 'team' | 'company' | 'location'>): string {
  return [p.role, p.team, p.company, p.location].filter(Boolean).join(' · ');
}

const planId = (targetId: string, role: string | undefined) =>
  `tp:${targetId}:${normalizeCompany(role ?? '') || (role ?? 'company').toLowerCase().replace(/\s+/g, '-')}`;

/** People picked in plans built this week (other than this one): nobody is picked twice. */
async function pickedThisWeek(userId: string, exceptId: string, now: Date): Promise<Set<string>> {
  const plans = await db.targetPlans.where('userId').equals(userId).toArray();
  return new Set(
    plans
      .filter((p) => p.id !== exceptId && now.getTime() - Date.parse(p.builtAt) < 7 * DAY)
      .flatMap((p) => p.steps.map((s) => s.personId)),
  );
}

/**
 * Build (or rebuild) the plan for a target and a posting, and keep it. Steps the student already drafted keep their
 * state when the same person is picked again; a pick who left the company drops out with the rebuild.
 */
export async function buildTargetPlan(
  user: User,
  target: TargetCompany,
  posting: PostingInfo,
  opts: { now?: Date } = {},
): Promise<TargetPlan> {
  const now = opts.now ?? new Date();
  const id = planId(target.id, posting.role);
  const [reach, chats, previous, exclude] = await Promise.all([
    reachCompany(user.id, target.organizationId ?? target.nameRaw, now),
    db.chats.where('userId').equals(user.id).toArray(),
    db.targetPlans.get(id),
    pickedThisWeek(user.id, id, now),
  ]);
  const goals = await db.goals.get(user.id);
  const picks = planPicks({
    people: reach.people,
    chats,
    posting,
    exclude,
    now,
    tz: user.timezone,
    fitRole: goals?.targetRoles[0] ?? goals?.targetFunctions[0],
  });
  const kept = new Map(
    (previous?.steps ?? []).filter((s) => s.status !== 'proposed').map((s) => [s.personId, s]),
  );
  const plan: TargetPlan = {
    id,
    userId: user.id,
    targetCompanyId: target.id,
    builtAt: now.toISOString(),
    posting,
    steps: picks.steps.map((s) => {
      const had = kept.get(s.personId);
      return had ? { ...s, status: had.status, suggestionId: had.suggestionId } : s;
    }),
    inPipeline: picks.inPipeline,
    more: picks.more,
    cold: reach.people.length === 0,
    suggestionIds: previous?.suggestionIds ?? [],
  };
  await db.targetPlans.put(plan);
  return plan;
}

/** LinkedIn people for the roles the network does not fill: three searches at most, under Discover's daily budget. */
export async function linkedInFinds(
  user: User,
  plan: TargetPlan,
  opts: { now?: Date } = {},
): Promise<{ role: TargetPlanStep['role']; found: FoundView }[]> {
  const now = opts.now ?? new Date();
  if (plan.steps.length >= 3 || !(await linkedInSearchReady(user))) return [];
  const company = plan.posting.company;
  const queries: [TargetPlanStep['role'], string, { title?: string; company?: string; school?: string }][] = [
    ['recruiter', `${company} recruiter`, { company, title: 'recruiter' }],
    ['team', `${company} ${plan.posting.role}`, { company }],
    ['alum', `${company} ${user.school}`, { company, school: user.school }],
  ];
  const have = new Set(plan.steps.map((s) => s.role));
  const out: { role: TargetPlanStep['role']; found: FoundView }[] = [];
  const seen = new Set(plan.steps.map((s) => s.personId));
  for (const [role, keywords, filters] of queries) {
    if (have.has(role) || out.length + plan.steps.length >= 3) continue;
    if (!usesMockConnectors(user.id)) {
      if (budgetLeft(await readBudget(user.id, now), 'search') <= 0) break;
      await spend(user.id, 'search', now);
    }
    const r = await searchLinkedInLive(user, keywords, {
      filters: role === 'team' ? filters : { company: filters.company },
    });
    if (!r.ok) break;
    const f = r.people.find(
      (p) =>
        !p.knownPersonId &&
        !seen.has(p.id) &&
        (normalizeCompany(p.headline ?? '').includes(normalizeCompany(company)) || !p.headline),
    );
    if (f) {
      seen.add(f.id);
      out.push({ role, found: f });
    }
  }
  return out;
}

/** Why this person, for the intro ask: "I'm applying for the Software Engineer Intern role at Stripe, and Priya recruits for it." */
export function whyLine(
  first: string,
  step: TargetPlanStep,
  posting: Pick<PostingInfo, 'role' | 'company'>,
): string {
  const clause = /^(the |on the )/.test(step.roleText)
    ? `is ${step.roleText}`
    : step.roleText === 'recruits for this posting'
      ? 'recruits for it'
      : step.roleText;
  return posting.role
    ? `I'm applying for the ${posting.role} role at ${posting.company}, and ${first} ${clause}.`
    : `I'm hoping to work at ${posting.company}, and ${first} ${clause}.`;
}

/** The suggestion card for a plan's first message to someone the student knows: the posting named in its reason. */
async function outreachCard(user: User, plan: TargetPlan, step: TargetPlanStep, now: Date) {
  const person = await db.people.get(step.personId);
  if (!person) return undefined;
  const dedupeKey = `plan:${plan.id}:${person.id}`;
  await upsertSuggestions(
    user.id,
    [
      {
        kind: 'new_outreach',
        personId: person.id,
        dedupeKey,
        reasonText: plan.posting.role
          ? `${person.firstName} ${step.roleText}: your plan for the ${plan.posting.role} role at ${plan.posting.company}`
          : `${person.firstName} ${step.roleText}: your plan for ${plan.posting.company}`,
        signals: { plan: 1 },
        payload: { targetCompanyId: plan.targetCompanyId, planId: plan.id },
        urgency: 0.7,
        goalRelevance: 0.9,
        confidence: 0.9,
        priorityScore: 0.75,
      },
    ],
    now,
  );
  const s = await db.suggestions.where('dedupeKey').equals(dedupeKey).first();
  if (!s) return undefined;
  if (!s.outboundMessageId) {
    const { draftForSuggestion } = await import('./brief');
    await draftForSuggestion(user, s, now);
  }
  return (await db.suggestions.get(s.id)) ?? s;
}

/**
 * Draft the steps (all of them, or the people picked): a first message for a direct tie, the intro ask with the note
 * to forward for a warm route, a warm-up for a cold one. A held step ("after Dana replies") is not drafted yet: the
 * reply check drafts it when the reply comes. Nothing is sent.
 */
export async function draftPlan(
  user: User,
  planIdOrPlan: string | TargetPlan,
  which?: string[],
  now = new Date(),
): Promise<{ drafted: number; held: number; plan: TargetPlan }> {
  const plan = typeof planIdOrPlan === 'string' ? await db.targetPlans.get(planIdOrPlan) : planIdOrPlan;
  if (!plan) throw new Error('No such plan');
  let drafted = 0;
  let held = 0;
  const ids = new Set(plan.suggestionIds);
  for (const step of plan.steps) {
    if (which && !which.includes(step.personId)) continue;
    if (step.status === 'held') {
      held++;
      continue;
    }
    if (step.status !== 'proposed') continue;
    const sId = await draftStep(user, plan, step, now);
    if (sId) ids.add(sId);
    step.suggestionId = sId ?? step.suggestionId;
    step.status = step.draft === 'warm_up' ? 'done' : 'drafted';
    drafted++;
  }
  plan.suggestionIds = [...ids];
  await db.targetPlans.put(plan);
  return { drafted, held, plan };
}

async function draftStep(
  user: User,
  plan: TargetPlan,
  step: TargetPlanStep,
  now: Date,
): Promise<string | undefined> {
  if (step.found) {
    // a LinkedIn find joins Orbit only now, when the student picked them
    const added = await addLinkedInFound(user, [step.found.id], now);
    if (!added.ok) return undefined;
    step.personId = added.people[0]!.id;
  }
  if (step.draft === 'intro_request' && step.route.viaId) {
    const target = await db.people.get(step.personId);
    const r = await requestIntro(user, step.route.viaId, step.personId, {
      path: { score: step.route.score, hops: step.route.hops },
      now,
      posting: plan.posting.role ? { role: plan.posting.role, team: plan.posting.team } : undefined,
      why: target ? whyLine(target.firstName, step, plan.posting) : undefined,
      targetCompanyId: plan.targetCompanyId,
    });
    return r?.suggestion.id;
  }
  if (step.draft === 'warm_up') {
    await startWarmUpOrOutreach(user, step.personId, 'linkedin', 'reach');
    return undefined;
  }
  return (await outreachCard(user, plan, step, now))?.id;
}

/**
 * The reply check's hook (plan 23 §4.6): a held step is drafted once the person it waits on has replied, or on its
 * day when nobody has. Returns how many steps it released.
 */
export async function releaseHeldSteps(user: User, now = new Date()): Promise<number> {
  const plans = await db.targetPlans.where('userId').equals(user.id).toArray();
  let released = 0;
  for (const plan of plans) {
    let changed = false;
    for (const step of plan.steps) {
      if (step.status !== 'held') continue;
      const after = step.when.afterPersonId;
      const chat = after
        ? await db.chats
            .where('personId')
            .equals(after)
            .filter((c) => !c.archivedAt)
            .first()
        : undefined;
      const replied = !!chat?.lastInboundAt && chat.lastInboundAt >= plan.builtAt;
      if (!replied && Date.parse(step.when.at) > now.getTime()) continue;
      // only a plan the student already started drafting goes on by itself
      if (!plan.steps.some((s) => s.status === 'drafted' || s.status === 'done')) continue;
      step.status = 'proposed';
      const sId = await draftStep(user, plan, step, now);
      step.suggestionId = sId;
      step.status = step.draft === 'warm_up' ? 'done' : 'drafted';
      if (sId) plan.suggestionIds = [...new Set([...plan.suggestionIds, sId])];
      released++;
      changed = true;
    }
    if (changed) await db.targetPlans.put(plan);
  }
  return released;
}

/** The plans a person is part of, for "In your plan for Stripe" on their page. */
export async function plansFor(userId: string, personId: string): Promise<TargetPlan[]> {
  return (await db.targetPlans.where('userId').equals(userId).toArray()).filter((p) =>
    p.steps.some((s) => s.personId === personId),
  );
}

/** A target from a posting (or a company alone), its organization tied, then the plan. */
export async function planForPosting(
  user: User,
  posting: PostingInfo,
  now = new Date(),
): Promise<TargetPlan> {
  const { target } = await addTarget(user.id, posting.company, {
    role: posting.role,
    team: posting.team,
    postingUrl: posting.url,
    postingSeenAt: posting.url ? now.toISOString() : undefined,
    deadline: posting.deadline,
  });
  if (!target) throw new Error('No company');
  return buildTargetPlan(user, target, posting, { now });
}

/**
 * What the student pasted (a job link, or a line like "Software Engineer Intern at Stripe") to the plan: the posting
 * read, the target added with its organization, the three picked. The honest states come back as a message.
 */
export async function planFromInput(
  user: User,
  input: string,
  now = new Date(),
): Promise<{ ok: true; plan: TargetPlan } | { ok: false; message: string }> {
  const link = linkIn(input);
  // a company name or "Role at Company" needs no server; a pasted posting's text does
  const typed = link ? undefined : postingFromText(input);
  const read = link
    ? await readPosting(user.id, { url: link }, { now })
    : typed
      ? ({ ok: true, posting: typed, source: 'typed' } as const)
      : await readPosting(user.id, { text: input }, { now });
  if (!read.ok) return { ok: false, message: read.message };
  if (!read.posting.company)
    return { ok: false, message: "That page doesn't look like a job posting. Try the company name." };
  const plan = await planForPosting(user, { ...read.posting, url: read.posting.url ?? link }, now);
  return { ok: true, plan };
}
