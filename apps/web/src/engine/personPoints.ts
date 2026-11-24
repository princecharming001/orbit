/**
 * What a Discover card says about someone. Two things, both from what Orbit holds and never guessed:
 *
 *  - why they are suggested (whyThemFor): the reasons behind the pick, strongest first, built by core's whyThem from
 *    signals read here: their company or role against the student's goals, the school and class year, the people
 *    you both know by name, an employer on both résumés, the city, a recent move, who could introduce you, and what
 *    has already passed between you (a reply, a meeting). When little is on record the block says so.
 *  - what else is worth knowing (personPoints): what makes them stand out (where they were before, what they wrote
 *    or spoke about, their topics), what they actually do (their own headline, how long in the role, details from
 *    your email and notes), and what the research brief found in common.
 */
import type {
  Affiliation,
  Dossier,
  Edge,
  Person,
  PersonFact,
  Recommendation,
  RecruitingGoals,
  ResumeFacet,
  TargetCompany,
  Touchpoint,
  User,
  WhyReason,
  WhySignals,
} from '@orbit/core';
import {
  functionPhrase,
  heldRole,
  LEVEL_RANK,
  matchedFunction,
  normalizeCompany,
  placeMatch,
  tieBand,
  titleChangedMeaningfully,
  titleFunctions,
  titleLevel,
  whyThem,
} from '@orbit/core';
import { db } from '../db/schema';
import { dossierView } from './research';

export type PointKind = 'common' | 'standout' | 'does' | 'timing';

export interface PersonPoint {
  kind: PointKind;
  text: string;
}

export const POINT_LABELS: Record<PointKind, string> = {
  common: 'In common',
  standout: 'Stands out',
  does: 'Does',
  timing: 'Why now',
};

export interface PointContext {
  user: Pick<User, 'id' | 'school'> &
    Partial<Pick<User, 'graduationYear' | 'majors' | 'currentCity' | 'homeCity'>>;
  goals?: Pick<RecruitingGoals, 'targetFunctions' | 'targetIndustries' | 'targetLocations'>;
  targetCompanies: Pick<TargetCompany, 'organizationId' | 'nameRaw' | 'priority' | 'status'>[];
  /** the student's own experience and interests, from their resume */
  mine: ResumeFacet[];
  people: Map<string, Person>;
  affiliations: Affiliation[];
  facts: PersonFact[];
  edges: Edge[];
  /** what passed between the student and these people, by date */
  touchpoints: Pick<Touchpoint, 'personId' | 'kind' | 'occurredAt'>[];
  /**
   * Pairs of people on one small email thread (three people or fewer, the student included), as "idA|idB" with
   * idA < idB: being copied together on a big thread does not mean two people know each other
   */
  smallThreads?: Set<string>;
  /** the subject line of the latest small email thread with each person, by person id */
  subjects?: Map<string, string>;
  dossier?: Dossier;
  now: Date;
}

const YEAR = 365.25 * 86_400_000;
const MONTH = YEAR / 12;
const EMAIL_TIES = new Set<Edge['type']>(['email_exchange', 'email_cc', 'email_cothread']);

/**
 * A tie that shows two people really know each other: an introduction, overlapping years at one employer (dates on
 * record), or a small email thread with both on it. Not the same employer with unknown dates, a big thread, or a
 * LinkedIn connection.
 */
function realTie(e: Edge, ctx: Pick<PointContext, 'smallThreads'>): boolean {
  if (e.type === 'introduced_by') return true;
  if (e.type === 'co_tenure')
    return (
      !e.evidence.datesUnknown && typeof e.evidence.overlapMonths === 'number' && e.evidence.overlapMonths > 0
    );
  if (EMAIL_TIES.has(e.type)) {
    const [a, b] = e.personAId < e.personBId ? [e.personAId, e.personBId] : [e.personBId, e.personAId];
    return !!ctx.smallThreads?.has(`${a}|${b}`);
  }
  return false;
}

/** Warm or closer to the student: "whom you know well" is only said of them. */
function knownWell(p: Person): boolean {
  const band = p.tieBand ?? tieBand(p.tieScore ?? p.strength * 100);
  return band === 'warm' || band === 'strong' || band === 'close';
}
const year = (iso?: string) => (iso ? new Date(iso).getFullYear() : undefined);
const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return /[.!?]$/.test(t) ? t.slice(0, -1) : t;
};
const listNames = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** Their jobs, newest first, and the one they hold now. */
function jobsOf(person: Person, ctx: Pick<PointContext, 'affiliations'>) {
  const jobs = ctx.affiliations
    .filter((a) => a.personId === person.id && a.kind === 'employment')
    .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''));
  const current = jobs.find((a) => a.isCurrent) ?? jobs[0];
  return { jobs, current };
}

/** The years of a stint, from its dates: "2021 to 2023", "since 2022", "2024". */
function yearsOf(start?: string, end?: string, current?: boolean): string | undefined {
  const y = (s?: string) => s?.match(/\b(19|20)\d{2}\b/)?.[0];
  const a = y(start);
  const b = y(end);
  if (current) return a ? `since ${a}` : undefined;
  if (a && b) return a === b ? a : `${a} to ${b}`;
  return a ?? b;
}

/** How a tie on record says two people know each other, after the first one's name ("worked with Maya at Ramp"). */
function tieHow(e: Edge, other: Person): string | undefined {
  const ev = e.evidence as Record<string, unknown>;
  const first = other.firstName || other.displayName;
  if (e.type === 'co_tenure' && typeof ev.orgName === 'string') {
    const from = typeof ev.fromYear === 'number' ? ev.fromYear : undefined;
    const to = typeof ev.toYear === 'number' ? ev.toYear : undefined;
    const years =
      from === undefined
        ? ''
        : ev.ongoing
          ? ` (since ${from})`
          : to && to !== from
            ? ` (${from} to ${to})`
            : ` (${from})`;
    return `${ev.ongoing ? 'works' : 'worked'} with ${first} at ${ev.orgName}${years}`;
  }
  if (e.type === 'introduced_by') return undefined;
  if (EMAIL_TIES.has(e.type)) return `was on a small email thread with you and ${first}`;
  return undefined;
}

/** The people the student knows well who really know this person (realTie), closest first, with how they know them. */
function mutualPeople(person: Person, ctx: PointContext): { p: Person; how?: string }[] {
  const out = new Map<string, { p: Person; how?: string }>();
  for (const e of ctx.edges) {
    if (!(e.personAId === person.id || e.personBId === person.id) || !realTie(e, ctx)) continue;
    const p = ctx.people.get(e.personAId === person.id ? e.personBId : e.personAId);
    if (!p || p.hiddenAt || p.id === person.id || !knownWell(p) || !p.firstName) continue;
    const had = out.get(p.id);
    if (!had) out.set(p.id, { p, how: tieHow(e, person) });
    else if (!had.how) had.how = tieHow(e, person);
  }
  // one line per first name, as the card says them
  const seen = new Set<string>();
  return [...out.values()]
    .sort((a, b) => b.p.strength - a.p.strength)
    .filter((m) => !seen.has(m.p.firstName) && !!seen.add(m.p.firstName));
}

const INBOUND: Touchpoint['kind'][] = ['email_in', 'linkedin_in', 'text_in'];
const OUTBOUND: Touchpoint['kind'][] = ['email_out', 'linkedin_out', 'text_out'];
const CHANNEL: Partial<Record<Touchpoint['kind'], 'email' | 'LinkedIn' | 'text'>> = {
  email_in: 'email',
  email_out: 'email',
  linkedin_in: 'LinkedIn',
  linkedin_out: 'LinkedIn',
  text_in: 'text',
  text_out: 'text',
};

/** What else is on record with someone the student knows a little, each as a short phrase. */
function lightTouches(mine: Pick<Touchpoint, 'kind' | 'occurredAt'>[]): { what: string[]; last?: string } {
  const n = (kinds: Touchpoint['kind'][]) => mine.filter((t) => kinds.includes(t.kind));
  const say = (count: number, one: string, many: string) =>
    count === 1 ? one : many.replace('#', String(count));
  const what: string[] = [];
  const used: Pick<Touchpoint, 'kind' | 'occurredAt'>[] = [];
  const add = (kinds: Touchpoint['kind'][], one: string, many: string) => {
    const xs = n(kinds);
    if (!xs.length) return;
    used.push(...xs);
    what.push(say(xs.length, one, many));
  };
  add(['email_cc'], 'you were both on an email thread', 'you were both on # email threads');
  add(
    ['linkedin_comment_in'],
    'they commented on your LinkedIn post',
    'they commented on # of your LinkedIn posts',
  );
  add(
    ['linkedin_reaction_in'],
    'they reacted to your LinkedIn post',
    'they reacted to # of your LinkedIn posts',
  );
  add(
    ['linkedin_comment_out'],
    'you commented on their LinkedIn post',
    'you commented on # of their LinkedIn posts',
  );
  add(
    ['instagram_in', 'instagram_out'],
    'you messaged on Instagram once',
    'you messaged on Instagram on # days',
  );
  add(['x_in', 'x_out'], 'you messaged on X once', 'you messaged on X on # days');
  add(['note', 'manual_log'], 'you logged a note about them', 'you logged # notes about them');
  const last = used
    .map((t) => t.occurredAt)
    .sort()
    .at(-1);
  return { what, last };
}

/**
 * The signals behind one network person's card, read from the account, for core's whyThem. A signal the account
 * does not hold is left out, so no line is written for it.
 */
export function whySignalsFor(
  person: Person,
  rec: Pick<Recommendation, 'reasons'> & Partial<Pick<Recommendation, 'bestPath'>>,
  ctx: PointContext,
  introducer?: Pick<Person, 'firstName'> & Partial<Pick<Person, 'id' | 'displayName'>>,
): WhySignals {
  const s: WhySignals = {
    firstName: person.firstName || undefined,
    title: person.currentTitle,
    company: person.currentOrganizationRaw,
    headline: person.headline,
    now: ctx.now,
  };
  const { jobs, current } = jobsOf(person, ctx);
  const orgKey = normalizeCompany(person.currentOrganizationRaw);
  // a LinkedIn re-import dates a role by when Orbit saw it, not when it began: no "since" from that date
  if (current?.startDate && current.source !== 'linkedin_csv' && year(current.startDate))
    s.since = current.startDate;

  // ---- the student's goals ----
  const tc = ctx.targetCompanies.find(
    (t) =>
      t.status !== 'closed' &&
      ((!!t.organizationId && t.organizationId === person.currentOrganizationId) ||
        (!!orgKey && normalizeCompany(t.nameRaw) === orgKey)),
  );
  const role = heldRole(person);
  const fn = role
    ? matchedFunction(`${role} ${person.currentOrganizationRaw ?? ''}`, ctx.goals?.targetFunctions ?? [])
    : undefined;
  const roleGoal = role && (fn || rec.reasons.some((r) => r.code === 'function_match'));
  // the role's own words ("Software" in "Software Engineer") are not the industry they work in
  const text = `${person.headline ?? ''} ${person.currentOrganizationRaw ?? ''}`
    .toLowerCase()
    .replace((role ?? person.currentTitle ?? '').toLowerCase() || '\u0000', ' ');
  const industry = (ctx.goals?.targetIndustries ?? []).find(
    (i) => i.trim().length > 1 && text.includes(i.trim().toLowerCase()),
  );
  if (tc || roleGoal || industry)
    s.goal = {
      company: tc ? { name: person.currentOrganizationRaw ?? tc.nameRaw, priority: tc.priority } : undefined,
      role: roleGoal
        ? { title: role, function: fn ? functionPhrase(fn) || undefined : undefined }
        : undefined,
      industry: industry?.trim(),
    };

  // ---- the school ----
  if (person.isAlumni && person.school) {
    const edu = ctx.affiliations
      .filter((a) => a.personId === person.id && a.kind === 'education')
      .sort((a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? ''))[0];
    const gradYear = year(edu?.endDate);
    const majors = (ctx.user.majors ?? []).map((m) => m.toLowerCase());
    const field = edu?.field?.trim();
    const program =
      field && majors.some((m) => field.toLowerCase().includes(m) || m.includes(field.toLowerCase()))
        ? field
        : undefined;
    s.school = {
      name: person.school,
      gradYear: gradYear && !Number.isNaN(gradYear) ? gradYear : undefined,
      myGradYear: ctx.user.graduationYear,
      program,
      degree: edu?.degree?.trim() || undefined,
    };
  }

  // ---- people you both know, someone who can introduce you ----
  const mates = mutualPeople(person, ctx);
  if (mates.length)
    s.mutuals = {
      names: mates.map((m) => m.p.firstName),
      people: mates.map((m) => ({
        id: m.p.id,
        name: m.p.displayName || m.p.firstName,
        firstName: m.p.firstName,
        how: m.how,
      })),
    };
  if (introducer?.firstName) {
    // the route's last hop says how the introducer knows them ("Lena worked with Maya at Ramp (2021 to 2023)")
    const hops = rec.bestPath?.hops ?? [];
    const last = hops.length === 2 && hops[0]!.toId === introducer.id ? hops[1]!.text?.trim() : undefined;
    const lead = `${introducer.firstName} `;
    const how = last?.startsWith(lead)
      ? last
          .slice(lead.length)
          .replace(/[.\s]+$/, '')
          // a stint still going is said in the present: "works with Maya at Ramp (since 2024)"
          .replace(/^worked with (.+\(since \d{4}\))$/, 'works with $1')
      : undefined;
    s.warmPath = {
      name: introducer.firstName,
      ...(introducer.id ? { id: introducer.id } : {}),
      ...(introducer.displayName ? { fullName: introducer.displayName } : {}),
      ...(how ? { how } : {}),
    };
  }

  // ---- an employer on both résumés ----
  const mineByOrg = new Map<string, ResumeFacet>();
  for (const f of ctx.mine)
    if (f.kind === 'experience' && f.organizationName && !f.excluded)
      mineByOrg.set(normalizeCompany(f.organizationName), f);
  const shared: NonNullable<WhySignals['pastEmployers']> = [];
  const seenOrg = new Set<string>();
  for (const j of jobs) {
    const k = normalizeCompany(j.nameRaw);
    const f = mineByOrg.get(k);
    if (!f || seenOrg.has(k)) continue;
    seenOrg.add(k);
    const theirTitle = j.title?.trim() || undefined;
    const theirYears = yearsOf(j.startDate, j.endDate, j.isCurrent);
    // a date imported from LinkedIn says when Orbit saw the role, not when it began
    const trusted = j.source !== 'linkedin_csv';
    const myYears = yearsOf(f.startDate, f.endDate, false);
    shared.push({
      name: f.organizationName!,
      mine: f.startDate && !f.endDate ? 'now' : /\bintern/i.test(f.title ?? '') ? 'interned' : 'worked',
      theirs: j.isCurrent ? 'now' : 'before',
      ...(theirTitle ? { theirTitle } : {}),
      ...(theirYears && trusted && !j.isCurrent ? { theirYears } : {}),
      ...(myYears ? { myYears } : {}),
    });
  }
  if (shared.length) s.pastEmployers = shared;

  // ---- the city ----
  const targets = (ctx.goals?.targetLocations ?? []).filter((l) => !/^remote$/i.test(l.trim()));
  const target = placeMatch(person.location, targets);
  const here = ctx.user.currentCity ? placeMatch(person.location, [ctx.user.currentCity]) : undefined;
  const home = ctx.user.homeCity ? placeMatch(person.location, [ctx.user.homeCity]) : undefined;
  const place = (p: string) => p.split(',')[0]!.trim();
  if (target) s.city = { name: place(target), why: 'target' };
  else if (here) s.city = { name: place(here), why: 'current' };
  else if (home) s.city = { name: place(home), why: 'home' };

  // ---- a recent move (a LinkedIn re-import dates a role by when Orbit saw it, not when it began) ----
  const started = current?.startDate ? new Date(current.startDate) : undefined;
  const otherOrg = (a: Affiliation) => normalizeCompany(a.nameRaw) !== normalizeCompany(current?.nameRaw);
  // the job before this one: it ended when this one began, by dates Orbit can trust (not a LinkedIn import's)
  const before = current
    ? jobs
        .filter((a) => a !== current && !a.isCurrent && a.endDate && a.source !== 'linkedin_csv')
        .sort((a, b) => b.endDate!.localeCompare(a.endDate!))[0]
    : undefined;
  const endedAt = before?.endDate ? new Date(before.endDate) : undefined;
  const gap =
    endedAt && started && !Number.isNaN(endedAt.getTime()) && !Number.isNaN(started.getTime())
      ? Math.abs(started.getTime() - endedAt.getTime()) / 86_400_000
      : undefined;
  const handover = gap !== undefined && gap <= 62 ? before : undefined;
  const changedAt =
    started && !Number.isNaN(started.getTime()) && current?.source !== 'linkedin_csv'
      ? started
      : handover && endedAt
        ? started && !Number.isNaN(started.getTime())
          ? started
          : endedAt
        : undefined;
  if (current && changedAt) {
    const monthsAgo = Math.floor((ctx.now.getTime() - changedAt.getTime()) / MONTH);
    if (monthsAgo >= 0 && monthsAgo < 12) {
      const moved = jobs.some((a) => a !== current && otherOrg(a));
      const promoted =
        !!handover &&
        !otherOrg(handover) &&
        !!current.title &&
        !!handover.title &&
        levelRank(current.title) > levelRank(handover.title);
      // their field before and after, when the move is the one the student is trying to make: out of the field of
      // their own experience (which they do not target) into one they target
      const fnOf = (t?: string) => [...titleFunctions(t)][0];
      const fromFn = handover && otherOrg(handover) ? fnOf(handover.title) : undefined;
      const toFn = fnOf(current.title);
      const targetsFns = ctx.goals?.targetFunctions ?? [];
      const myFns = new Set(
        ctx.mine
          .filter((f) => f.kind === 'experience' && !f.excluded)
          .flatMap((f) => [...titleFunctions(f.title)]),
      );
      const sameSwitch =
        fromFn &&
        toFn &&
        fromFn !== toFn &&
        targetsFns.includes(toFn) &&
        !targetsFns.includes(fromFn) &&
        myFns.has(fromFn)
          ? { from: functionPhrase(fromFn), to: functionPhrase(toFn) }
          : undefined;
      s.roleChange = {
        monthsAgo,
        company: current.nameRaw,
        title: current.title,
        moved,
        at: changedAt.toISOString(),
        ...(handover ? { fromCompany: handover.nameRaw, fromTitle: handover.title } : {}),
        ...(promoted ? { promoted } : {}),
        ...(sameSwitch?.from && sameSwitch.to ? { sameSwitch } : {}),
      };
    }
  }

  // ---- what has passed between you ----
  const mine = ctx.touchpoints
    .filter((t) => t.personId === person.id)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const last = (kinds: Touchpoint['kind'][]) => mine.find((t) => kinds.includes(t.kind))?.occurredAt;
  const inbound = last(INBOUND);
  const outbound = last(OUTBOUND);
  const metAt = last(['meeting']);
  // an inbound message after one of the student's is a reply; one with none before it is them writing first
  const firstOut = mine.filter((t) => OUTBOUND.includes(t.kind)).at(-1);
  const replied = inbound && firstOut && firstOut.occurredAt < inbound;
  // the conversation, counted: how many each way, over what, from when to when, and who wrote last
  const talk = mine.filter((t) => INBOUND.includes(t.kind) || OUTBOUND.includes(t.kind));
  const channels = new Set(talk.map((t) => CHANNEL[t.kind]).filter(Boolean));
  const subject = ctx.subjects?.get(person.id);
  const touches = lightTouches(mine);
  const history: NonNullable<WhySignals['history']> = {
    repliedAt: replied ? inbound : undefined,
    theyWroteAt: inbound && !replied ? inbound : undefined,
    wroteAt: outbound,
    metAt,
    connectedOn: person.linkedinConnectedOn,
    knownALittle: person.strength >= 0.3 || rec.reasons.some((r) => r.code === 'warm'),
  };
  if (talk.length)
    history.talk = {
      fromThem: talk.filter((t) => INBOUND.includes(t.kind)).length,
      fromYou: talk.filter((t) => OUTBOUND.includes(t.kind)).length,
      channel: channels.size === 1 ? [...channels][0] : channels.size > 1 ? 'mixed' : undefined,
      firstAt: talk.at(-1)!.occurredAt,
      lastAt: talk[0]!.occurredAt,
      lastFrom: INBOUND.includes(talk[0]!.kind) ? 'them' : 'you',
      ...(subject ? { subject } : {}),
    };
  const meetings = mine.filter((t) => t.kind === 'meeting').length;
  if (meetings) history.meetings = meetings;
  if (touches.what.length) {
    history.touches = touches.what;
    if (touches.last) history.lastTouchAt = touches.last;
  }
  if (Object.values(history).some(Boolean)) s.history = history;
  return s;
}

/** A title's level as a number, to tell a promotion from a sideways move (0 when the title says none). */
function levelRank(title: string): number {
  const l = titleLevel(title);
  return l ? LEVEL_RANK[l] : 0;
}

/** Why this person is suggested: the reasons, strongest first (core whyThem over the signals read here). */
export function whyThemFor(
  person: Person,
  rec: Pick<Recommendation, 'reasons'> & Partial<Pick<Recommendation, 'bestPath'>>,
  ctx: PointContext,
  introducer?: Pick<Person, 'firstName'> & Partial<Pick<Person, 'id' | 'displayName'>>,
): WhyReason[] {
  return whyThem(whySignalsFor(person, rec, ctx, introducer));
}

/**
 * Why a recommended person is worth writing to, read now, for a card outside Discover (a first-message card in
 * Drafts or on their page): the same reasons their Discover card gives. Empty when the recommendation is gone.
 */
export async function whyForRecommendation(
  user: PointContext['user'],
  person: Person,
  recommendationId: string,
  now = new Date(),
): Promise<WhyReason[]> {
  const rec = await db.recommendations.get(recommendationId);
  if (!rec || rec.personId !== person.id) return [];
  const ctx = await loadPointContext(user, [person.id], now);
  const hops = rec.bestPath?.hops ?? [];
  const introducer = hops.length >= 2 ? ctx.people.get(hops[0]!.toId) : undefined;
  return whyThem(whySignalsFor(person, rec, { ...ctx, dossier: ctx.dossiers.get(person.id) }, introducer), {
    filler: false,
  });
}

/** The points for one person beyond the reasons, strongest first, without repeats. */
export function personPoints(person: Person, rec: Recommendation, ctx: PointContext): PersonPoint[] {
  const out: PersonPoint[] = [];
  const add = (kind: PointKind, text: string | undefined) => {
    if (!text) return;
    const t = sentence(text);
    if (t.length < 4 || out.some((p) => p.text.toLowerCase() === t.toLowerCase())) return;
    out.push({ kind, text: t });
  };
  const { jobs, current } = jobsOf(person, ctx);
  // earlier employers, not an earlier title at the same one
  const past = jobs.filter(
    (a) =>
      a !== current && !a.isCurrent && normalizeCompany(a.nameRaw) !== normalizeCompany(current?.nameRaw),
  );
  const view =
    ctx.dossier && (ctx.dossier.status === 'ready' || ctx.dossier.status === 'partial')
      ? dossierView(ctx.dossier)
      : undefined;
  const facts = ctx.facts.filter((f) => f.personId === person.id);

  // ---- in common (the shared employer, the school and the people you both know are reasons, not points) ----
  for (const c of view?.inCommon ?? []) add('common', c.text);
  const myInterests = ctx.mine.filter((f) => f.kind === 'interest' && !f.excluded);
  for (const f of facts.filter((x) => x.type === 'personal')) {
    if (myInterests.some((i) => f.text.toLowerCase().includes(i.text.toLowerCase().slice(0, 12))))
      add('common', f.text);
  }
  for (const r of rec.reasons) {
    // the reason's own words say what overlaps; a line that would fit anyone is left out
    if (r.code === 'resume_overlap' && r.text && !/^their work overlaps/i.test(r.text)) add('common', r.text);
  }

  // ---- stands out ----
  for (const h of view?.highlights.slice(0, 2) ?? []) {
    const verb =
      h.kind === 'talk'
        ? 'Gave a talk'
        : h.kind === 'podcast'
          ? 'Was on a podcast'
          : h.kind === 'paper'
            ? 'Published'
            : h.kind === 'project'
              ? 'Built'
              : 'Wrote';
    add('standout', `${verb}: “${h.title}”`);
  }
  if (past.length) {
    const names = [...new Set(past.map((a) => a.nameRaw))].slice(0, 2);
    add('standout', `Previously at ${listNames(names)}`);
  }
  for (const f of facts.filter((x) => x.type === 'background' || x.type === 'hook').slice(0, 2))
    add('standout', f.text);
  if (view?.topics.length)
    add('standout', `Works on ${listNames(view.topics.slice(0, 3).map((t) => t.toLowerCase()))}`);

  // ---- does ----
  const title = (person.currentTitle ?? '').toLowerCase();
  const org = (person.currentOrganizationRaw ?? '').toLowerCase();
  if (
    person.headline &&
    !(
      person.headline.toLowerCase().includes(title) &&
      person.headline.toLowerCase().includes(org) &&
      person.headline.length < title.length + org.length + 8
    )
  )
    add('does', person.headline);
  else if (view?.who) add('does', view.who.split(/(?<=\.)\s/)[0]);
  const role = facts.find((f) => f.type === 'role_detail');
  if (role) add('does', role.text);
  const started = current?.startDate ? new Date(current.startDate) : undefined;
  // a LinkedIn re-import dates a role by when Orbit saw it, not when it began: no "since" or "joined" from that date
  const observed = current?.source === 'linkedin_csv';
  if (started && !observed && !Number.isNaN(started.getTime())) {
    const yrs = (ctx.now.getTime() - started.getTime()) / YEAR;
    if (yrs >= 1.5) add('does', `${Math.floor(yrs)} years in the role, since ${year(current!.startDate)}`);
  }

  // ---- why now: what a re-import saw (a recent start on record is a reason, "New in the role") ----
  if (started && observed && (ctx.now.getTime() - started.getTime()) / YEAR < 1) {
    const replaced = jobs.find(
      (a) => !a.isCurrent && a.endDate?.slice(0, 10) === current!.startDate!.slice(0, 10),
    );
    if (replaced && normalizeCompany(replaced.nameRaw) !== normalizeCompany(current!.nameRaw))
      add('timing', `Moved from ${replaced.nameRaw} to ${current!.nameRaw}`);
    else if (replaced && current!.title && titleChangedMeaningfully(replaced.title, current!.title))
      add('timing', `New role: ${current!.title}`);
  }

  const order: PointKind[] = ['common', 'standout', 'does', 'timing'];
  // the best of each kind first, then the rest in the same order
  const firsts = order.map((k) => out.find((p) => p.kind === k)).filter((p): p is PersonPoint => !!p);
  return [...firsts, ...out.filter((p) => !firsts.includes(p))].slice(0, 7);
}

/** Everything the reasons and points need for a set of people, read once for the whole page. */
export async function loadPointContext(
  user: PointContext['user'],
  personIds: string[],
  now = new Date(),
  /** the student's people when the caller has them already (Discover's view reads them once) */
  known?: Person[],
): Promise<LoadedPointContext> {
  const ids = new Set(personIds);
  const list = [...ids];
  const [
    people,
    affiliations,
    facts,
    edges,
    dossiers,
    resumes,
    threads,
    goals,
    targetCompanies,
    touchpoints,
  ] = await Promise.all([
    known ?? db.people.where('userId').equals(user.id).toArray(),
    db.affiliations.where('personId').anyOf(list).toArray(),
    db.facts.where('personId').anyOf(list).toArray(),
    db.edges.where('userId').equals(user.id).toArray(),
    db.dossiers.where('personId').anyOf(list).toArray(),
    db.resumes.where('userId').equals(user.id).toArray(),
    db.threads.where('userId').equals(user.id).toArray(),
    db.goals.get(user.id),
    db.targetCompanies.where('userId').equals(user.id).toArray(),
    db.touchpoints.where('personId').anyOf(list).toArray(),
  ]);
  // small threads with one of these people on them: who was on a thread of three or fewer with whom
  const smallThreads = new Set<string>();
  // the subject of the latest email thread that is only the student and one of these people
  const subjects = new Map<string, string>();
  const subjectAt = new Map<string, string>();
  for (const t of threads) {
    const on = t.participantPersonIds ?? [];
    if (on.length !== 1 || !ids.has(on[0]!) || (t.participantEmails ?? []).length > 2) continue;
    if (t.channel && t.channel !== 'gmail') continue;
    const at = t.lastMessageAt ?? t.firstMessageAt ?? '';
    if (!t.subject?.trim() || (subjectAt.get(on[0]!) ?? '') > at) continue;
    subjects.set(on[0]!, t.subject.trim());
    subjectAt.set(on[0]!, at);
  }
  for (const t of threads) {
    // older and synced threads can lack either list; a missing one counts as empty, never a crash
    const on = [...new Set(t.participantPersonIds ?? [])];
    // three people at most, the student included: the two of them and the student (whose address is among them)
    if (on.length !== 2 || (t.participantEmails ?? []).length > 3 || !on.some((id) => ids.has(id))) continue;
    for (const a of on) for (const b of on) if (a < b) smallThreads.add(`${a}|${b}`);
  }
  const resume =
    resumes.find((r) => r.isCurrent) ?? resumes.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const mine = resume ? await db.resumeFacets.where('resumeId').equals(resume.id).toArray() : [];
  return {
    user,
    goals: goals ?? undefined,
    targetCompanies,
    mine,
    people: new Map(people.map((p) => [p.id, p])),
    affiliations,
    facts: facts.filter((f) => !f.deletedAt),
    edges: edges.filter((e) => ids.has(e.personAId) || ids.has(e.personBId)),
    touchpoints,
    smallThreads,
    subjects,
    dossiers: new Map(dossiers.map((d) => [d.personId, d])),
    now,
    forIds: ids,
  };
}

/** A point context read for a set of people (`forIds`), with each one's research brief. */
export type LoadedPointContext = Omit<PointContext, 'dossier'> & {
  dossiers: Map<string, Dossier>;
  forIds: Set<string>;
};
