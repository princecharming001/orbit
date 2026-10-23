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
  matchedFunction,
  normalizeCompany,
  placeMatch,
  tieBand,
  titleChangedMeaningfully,
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

/** The people the student knows well who really know this person (realTie), closest first, by first name. */
function mutualNames(person: Person, ctx: PointContext): string[] {
  const known = ctx.edges
    .filter((e) => (e.personAId === person.id || e.personBId === person.id) && realTie(e, ctx))
    .map((e) => ctx.people.get(e.personAId === person.id ? e.personBId : e.personAId))
    .filter((p): p is Person => !!p && !p.hiddenAt && p.id !== person.id && knownWell(p))
    .sort((a, b) => b.strength - a.strength);
  return [...new Set(known.map((p) => p.firstName).filter(Boolean))];
}

/**
 * The signals behind one network person's card, read from the account, for core's whyThem. A signal the account
 * does not hold is left out, so no line is written for it.
 */
export function whySignalsFor(
  person: Person,
  rec: Pick<Recommendation, 'reasons'>,
  ctx: PointContext,
  introducer?: Pick<Person, 'firstName'>,
): WhySignals {
  const s: WhySignals = {
    title: person.currentTitle,
    company: person.currentOrganizationRaw,
    headline: person.headline,
    now: ctx.now,
  };
  const { jobs, current } = jobsOf(person, ctx);
  const orgKey = normalizeCompany(person.currentOrganizationRaw);

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
  const text = `${person.headline ?? ''} ${person.currentOrganizationRaw ?? ''}`.toLowerCase();
  const industry = (ctx.goals?.targetIndustries ?? []).find(
    (i) => i.trim().length > 1 && text.includes(i.trim().toLowerCase()),
  );
  if (tc || roleGoal || industry)
    s.goal = {
      company: tc ? { name: person.currentOrganizationRaw ?? tc.nameRaw, priority: tc.priority } : undefined,
      role: roleGoal
        ? { title: role, function: fn ? functionPhrase(fn) || undefined : undefined }
        : undefined,
      industry: industry?.trim().toLowerCase(),
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
    };
  }

  // ---- people you both know, someone who can introduce you ----
  const names = mutualNames(person, ctx);
  if (names.length) s.mutuals = { names };
  if (introducer?.firstName) s.warmPath = { name: introducer.firstName };

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
    shared.push({
      name: f.organizationName!,
      mine: f.startDate && !f.endDate ? 'now' : /\bintern/i.test(f.title ?? '') ? 'interned' : 'worked',
      theirs: j.isCurrent ? 'now' : 'before',
    });
  }
  if (shared.length) s.pastEmployers = shared;

  // ---- the city ----
  const targets = (ctx.goals?.targetLocations ?? []).filter((l) => !/^remote$/i.test(l.trim()));
  const target = placeMatch(person.location, targets);
  const home = placeMatch(
    person.location,
    [ctx.user.currentCity, ctx.user.homeCity].filter((c): c is string => !!c),
  );
  const place = (p: string) => p.split(',')[0]!.trim();
  if (target) s.city = { name: place(target), why: 'target' };
  else if (home) s.city = { name: place(home), why: 'home' };

  // ---- a recent move (a LinkedIn re-import dates a role by when Orbit saw it, not when it began) ----
  const started = current?.startDate ? new Date(current.startDate) : undefined;
  if (started && !Number.isNaN(started.getTime()) && current?.source !== 'linkedin_csv') {
    const monthsAgo = Math.floor((ctx.now.getTime() - started.getTime()) / MONTH);
    if (monthsAgo >= 0 && monthsAgo < 12)
      s.roleChange = {
        monthsAgo,
        company: current!.nameRaw,
        title: current!.title,
        moved: jobs.some(
          (a) => a !== current && normalizeCompany(a.nameRaw) !== normalizeCompany(current!.nameRaw),
        ),
      };
  }

  // ---- what has passed between you ----
  const mine = ctx.touchpoints
    .filter((t) => t.personId === person.id)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const last = (kinds: Touchpoint['kind'][]) => mine.find((t) => kinds.includes(t.kind))?.occurredAt;
  const inbound = last(['email_in', 'linkedin_in', 'text_in']);
  const outbound = last(['email_out', 'linkedin_out', 'text_out']);
  const metAt = last(['meeting']);
  // an inbound message after one of the student's is a reply; one with none before it is them writing first
  const firstOut = mine.filter((t) => ['email_out', 'linkedin_out', 'text_out'].includes(t.kind)).at(-1);
  const replied = inbound && firstOut && firstOut.occurredAt < inbound;
  const history: NonNullable<WhySignals['history']> = {
    repliedAt: replied ? inbound : undefined,
    theyWroteAt: inbound && !replied ? inbound : undefined,
    wroteAt: outbound,
    metAt,
    connectedOn: person.linkedinConnectedOn,
    knownALittle: person.strength >= 0.3 || rec.reasons.some((r) => r.code === 'warm'),
  };
  if (Object.values(history).some(Boolean)) s.history = history;
  return s;
}

/** Why this person is suggested: the reasons, strongest first (core whyThem over the signals read here). */
export function whyThemFor(
  person: Person,
  rec: Pick<Recommendation, 'reasons'>,
  ctx: PointContext,
  introducer?: Pick<Person, 'firstName'>,
): WhyReason[] {
  return whyThem(whySignalsFor(person, rec, ctx, introducer));
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
): Promise<Omit<PointContext, 'dossier'> & { dossiers: Map<string, Dossier> }> {
  const ids = new Set(personIds);
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
    db.people.where('userId').equals(user.id).toArray(),
    db.affiliations
      .where('personId')
      .anyOf([...ids])
      .toArray(),
    db.facts
      .where('personId')
      .anyOf([...ids])
      .toArray(),
    db.edges.where('userId').equals(user.id).toArray(),
    db.dossiers
      .where('personId')
      .anyOf([...ids])
      .toArray(),
    db.resumes.where('userId').equals(user.id).toArray(),
    db.threads.where('userId').equals(user.id).toArray(),
    db.goals.get(user.id),
    db.targetCompanies.where('userId').equals(user.id).toArray(),
    db.touchpoints
      .where('personId')
      .anyOf([...ids])
      .toArray(),
  ]);
  // small threads with one of these people on them: who was on a thread of three or fewer with whom
  const smallThreads = new Set<string>();
  for (const t of threads) {
    const on = [...new Set(t.participantPersonIds)];
    // three people at most, the student included: the two of them and the student (whose address is among them)
    if (on.length !== 2 || t.participantEmails.length > 3 || !on.some((id) => ids.has(id))) continue;
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
    dossiers: new Map(dossiers.map((d) => [d.personId, d])),
    now,
  };
}
